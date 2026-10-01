"""Tests for how the LB-05 service is built (lb05/service.py): it starts only when every part it needs is proven.

A part that can't be built stops LB-05 and says why in the log, and the other systems of the monolith are untouched.
No database is needed: the engine here is made, never connected, and readiness is shown to follow it.
"""

import logging
import shutil
from pathlib import Path

import pytest
from sqlalchemy import Engine

from core.databases import create_system_engine
from core.platform import REPOSITORY_ROOT
from lb05.pipeline import AnalystPipeline
from lb05.service import DEFAULT_WAREHOUSE_DIRECTORY, build_service, warehouse_directory
from tests.support import DATA_AS_OF, FakeChat, make_environment, make_platform

# A Postgres that is not there: the port is closed, so the connection is refused at once.
NO_DATABASE = "postgres://lb:lb@127.0.0.1:1/lb"


@pytest.fixture
def dead_engine() -> Engine:
    """Return LB-05's engine pointed at a database that isn't running."""
    return create_system_engine(NO_DATABASE, "lb05")


def test_the_dataset_is_read_from_the_configured_folder_else_from_the_repository(tmp_path: Path) -> None:
    """LB05_WAREHOUSE_DIR says where; without it, data/generated/lb05 in the repository."""
    configured = make_platform(environment=make_environment(LB05_WAREHOUSE_DIR=str(tmp_path)))

    assert warehouse_directory(configured) == tmp_path
    assert warehouse_directory(make_platform()) == DEFAULT_WAREHOUSE_DIRECTORY
    assert DEFAULT_WAREHOUSE_DIRECTORY == REPOSITORY_ROOT / "data" / "generated" / "lb05"


def test_without_a_dataset_the_service_does_not_start_and_says_why(
    tmp_path: Path, dead_engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    """No data written yet (`just seed-lb05` not run): no service, and a log line that names the problem."""
    platform = make_platform(
        engines={"lb05": dead_engine}, environment=make_environment(LB05_WAREHOUSE_DIR=str(tmp_path / "nothing"))
    )

    with caplog.at_level(logging.ERROR):
        service = build_service(platform)

    assert service is None
    assert "LB-05 can't start" in caplog.text


def test_a_damaged_dataset_does_not_start_the_service(
    small_data: Path, tmp_path: Path, dead_engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    """A dataset whose meta.json was tampered with is refused rather than served."""
    damaged = tmp_path / "damaged"
    shutil.copytree(small_data, damaged)
    (damaged / "meta.json").write_text("{not json", encoding="utf-8")
    platform = make_platform(
        engines={"lb05": dead_engine}, environment=make_environment(LB05_WAREHOUSE_DIR=str(damaged))
    )

    with caplog.at_level(logging.ERROR):
        service = build_service(platform)

    assert service is None
    assert "LB-05 can't start" in caplog.text


def test_without_a_gateway_the_service_has_its_layer_and_data_but_no_pipeline(
    small_data: Path, dead_engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    """With no gateway settings LB-05 can show its layer and quota, and says it can't answer questions."""
    platform = make_platform(
        engines={"lb05": dead_engine}, environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data))
    )

    with caplog.at_level(logging.WARNING):
        service = build_service(platform)

    assert service is not None
    assert service.pipeline is None
    assert service.layer.version == 1
    assert service.warehouse.meta.as_of == DATA_AS_OF
    assert "can't answer questions" in caplog.text
    service.warehouse.close()


def test_with_a_gateway_the_service_gets_a_pipeline_on_the_platforms_models_and_spans(
    small_data: Path, dead_engine: Engine
) -> None:
    """The pipeline asks the platform's chat and records on the platform's tracer: nothing else is reachable."""
    chat = FakeChat({})
    platform = make_platform(
        chat=chat, engines={"lb05": dead_engine}, environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data))
    )

    service = build_service(platform)

    assert service is not None
    assert isinstance(service.pipeline, AnalystPipeline)
    assert service.pipeline.chat is chat
    assert service.pipeline.tracer is platform.tracer
    service.warehouse.close()


def test_readiness_follows_the_database(small_data: Path, dead_engine: Engine) -> None:
    """The service is not ready while its database doesn't answer, so it is taken out of rotation, not restarted."""
    platform = make_platform(
        engines={"lb05": dead_engine}, environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data))
    )

    service = build_service(platform)

    assert service is not None
    assert service.is_ready() is False
    service.warehouse.close()
