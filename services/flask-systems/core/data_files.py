"""Strict reading of the repository's YAML data files: the semantic layer and the golden sets.

Every file is parsed with a safe loader, which never builds Python objects, and checked
against a Pydantic schema in which an unknown field is an error. A problem stops the
reader with a message naming the file and the path of each bad field inside it.

The Django systems read their data the same way (services/django-systems/core/data_files.py);
the two services share no code, so each keeps its own copy of these few lines.
"""

from pathlib import Path
from typing import Annotated

import yaml
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError

# Stable names such as `repeat_buyers` or `cus-0001`: lowercase words joined by dots, hyphens or underscores.
Key = Annotated[str, StringConstraints(pattern=r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$", max_length=80)]
# A title or a passage of text, trimmed, never empty.
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000)]


class DataFileError(Exception):
    """A data file is missing or unreadable, or it doesn't follow its schema."""


class StrictEntry(BaseModel):
    """The base of every data-file schema: an unknown field is an error, never silently dropped."""

    model_config = ConfigDict(extra="forbid", frozen=True)


def read_data_file[Schema: StrictEntry](path: Path, schema: type[Schema]) -> Schema:
    """Read one YAML data file and check it against its schema, naming the file in any error."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise DataFileError(f"{path} can't be read: {error.strerror}") from None
    try:
        content = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise DataFileError(f"{path} isn't valid YAML: {error}") from None
    try:
        return schema.model_validate(content)
    except ValidationError as error:
        problems = [f"{'.'.join(str(part) for part in issue['loc'])}: {issue['msg']}" for issue in error.errors()]
        raise DataFileError(f"{path} doesn't follow its schema:\n- " + "\n- ".join(problems)) from None
