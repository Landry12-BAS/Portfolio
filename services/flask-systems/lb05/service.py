"""LB-05 as the running service holds it: the semantic layer, the warehouse, the pipeline and the quota ledger.

`build_service` loads each part and proves it before the service starts to serve: the semantic layer
is read and every expression in it is run through the SQL check, the warehouse is opened read-only and
locked and must hold exactly what the layer describes, and the ledger gets the system's own Postgres
engine. A part that can't be built stops LB-05 from serving (its routes answer 503 and its readiness
check fails) without stopping the other systems of the monolith.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from core.data_files import DataFileError
from core.databases import can_query
from core.platform import REPOSITORY_ROOT, Platform
from lb05.pipeline import AnalystPipeline
from lb05.quota import Ledger, PostgresLedger
from lb05.semantic_check import load_semantic_layer
from lb05.semantic_layer import SemanticLayer
from lb05.sql_policy import SqlPolicy
from lb05.warehouse import Warehouse, WarehouseError
from lb05.warehouse_build import WarehouseMetaError

logger = logging.getLogger(__name__)

# Where `just seed-lb05` writes the generated dataset, unless LB05_WAREHOUSE_DIR says otherwise (git-ignored).
DEFAULT_WAREHOUSE_DIRECTORY = REPOSITORY_ROOT / "data" / "generated" / "lb05"


@dataclass(frozen=True)
class Lb05Service:
    """The parts of the running LB-05 service. `pipeline` is None when the service has no gateway to ask."""

    layer: SemanticLayer
    warehouse: Warehouse
    pipeline: AnalystPipeline | None
    ledger: Ledger
    database_check: Callable[[], bool]

    def is_ready(self) -> bool:
        """Tell whether the service can serve right now: its database answers (the warehouse is open already)."""
        return self.database_check()


def warehouse_directory(platform: Platform) -> Path:
    """Return the folder holding the dataset: LB05_WAREHOUSE_DIR when set, else the repository's data/generated/lb05."""
    configured = platform.environment.lb05_warehouse_dir
    return Path(configured) if configured else DEFAULT_WAREHOUSE_DIRECTORY


def build_service(platform: Platform) -> Lb05Service | None:
    """Build the service from the platform, or return None, saying why in the log, when a part can't be built."""
    environment = platform.environment
    try:
        layer = load_semantic_layer(platform.seed_directory() / "lb05")
        warehouse = Warehouse.open(
            warehouse_directory(platform), environment.duckdb_memory_limit, environment.duckdb_threads
        )
        warehouse.check_matches(layer)
    except (DataFileError, WarehouseError, WarehouseMetaError) as error:
        logger.error("LB-05 can't start: %s", error)
        return None
    engine = platform.engines["lb05"]
    pipeline = None
    if platform.chat is not None:
        pipeline = AnalystPipeline(layer, SqlPolicy(layer), warehouse, platform.chat, platform.tracer)
    else:
        logger.warning("LB-05 has no gateway: it serves its semantic layer and quota, and can't answer questions.")
    return Lb05Service(
        layer=layer,
        warehouse=warehouse,
        pipeline=pipeline,
        ledger=PostgresLedger(engine, platform.clock),
        database_check=lambda: can_query(engine),
    )
