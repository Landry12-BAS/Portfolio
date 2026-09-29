"""Helpers the Django systems' tests share."""

from lb01.models import EMBEDDING_DIMENSIONS


def one_hot(position: int) -> list[float]:
    """Make a unit vector along one dimension: a stand-in embedding that is close only to itself."""
    vector = [0.0] * EMBEDDING_DIMENSIONS
    vector[position] = 1.0
    return vector
