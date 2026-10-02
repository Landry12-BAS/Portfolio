"""The typed invoice LB-03 extracts: what a model fills in, and what the checks, the boxes and the exports read.

A model's JSON is untrusted input. Every field here is checked when the reply is read: text is cleaned
of control characters and bounded, an amount must be an amount (a `Decimal`, never a float), a date must
be `YYYY-MM-DD`, and the lists are short. A field the document doesn't print is `None`: whether that is
acceptable is for the checks (lb03/checks.py) to say, so that a receipt with no number is a document with
a failed check and not a failed document. An unknown key in the reply is ignored, which costs no repair.

A visitor's edit goes through the same validators: `set_field` builds the invoice again from its own
data with the one text replaced, so a typo in an amount is refused and never stored.
"""

import re
from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from lb03.money import amount_text, quantity_text, to_decimal

# The currencies a Basalt & Bean supplier invoices in. A document in another one fails the `currency_known` check.
CURRENCIES: tuple[str, ...] = ("CZK", "EUR", "USD", "GBP", "PLN", "CHF", "HUF")
type DocumentType = Literal["invoice", "credit_note", "receipt"]
DOCUMENT_TYPES: tuple[str, ...] = ("invoice", "credit_note", "receipt")
# How many line items and VAT lines one document may have. A longer list is a misreading, or an attack on the prompt.
MAX_LINE_ITEMS = 40
MAX_VAT_LINES = 8
# Text limits, in characters.
MAX_VENDOR_CHARS = 120
MAX_NUMBER_CHARS = 40
MAX_DESCRIPTION_CHARS = 160
# What a model writes for "there is none".
NOTHING = frozenset({"", "null", "none", "n/a", "na", "-", "—"})
# The symbols a model may write instead of a currency's code.
CURRENCY_SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "kc": "CZK", "kč": "CZK", "zł": "PLN", "ft": "HUF"}
ISO_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
CURRENCY_CODE = re.compile(r"^[A-Z]{3}$")
# A path to one field of an invoice: `total`, `line_items.0.total`, `vat.1.rate`.
FIELD_PATH = re.compile(r"^(?:[a-z_]{1,20}|(?:line_items|vat)\.[0-9]{1,2}\.[a-z_]{1,20})$")


def _clean_text(value: object, limit: int) -> str | None:
    """Read text a model wrote: control characters become spaces, and empty or `null` is None."""
    if value is None:
        return None
    if not isinstance(value, str | int | float) or isinstance(value, bool):
        raise ValueError("This field is text.")
    text = " ".join("".join(character if character.isprintable() else " " for character in str(value)).split())
    if text.lower() in NOTHING:
        return None
    if len(text) > limit:
        raise ValueError(f"This text is longer than {limit} characters.")
    return text


def _vendor(value: object) -> str | None:
    """Read a vendor's name."""
    return _clean_text(value, MAX_VENDOR_CHARS)


def _number(value: object) -> str | None:
    """Read an invoice number."""
    return _clean_text(value, MAX_NUMBER_CHARS)


def _description(value: object) -> str:
    """Read a line item's description: text, empty when the model gave none."""
    return _clean_text(value, MAX_DESCRIPTION_CHARS) or ""


def _amount(value: object) -> Decimal | None:
    """Read an amount a model wrote, or None for `null`, an empty string or a dash."""
    if value is None or (isinstance(value, str) and value.strip().lower() in NOTHING):
        return None
    return to_decimal(value)


def _day(value: object) -> date | None:
    """Read a date a model wrote: `YYYY-MM-DD` and nothing else, or None for `null` or an empty string."""
    if value is None or (isinstance(value, str) and value.strip().lower() in NOTHING):
        return None
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not ISO_DATE.fullmatch(value.strip()):
        raise ValueError("Dates are written YYYY-MM-DD.")
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        raise ValueError("This is not a date that exists.") from None


def _currency(value: object) -> str | None:
    """Read a currency: a three-letter code in capitals, or one of the common symbols, or None."""
    text = _clean_text(value, 12)
    if text is None:
        return None
    symbol = CURRENCY_SYMBOLS.get(text.lower())
    code = symbol or text.upper()
    if not CURRENCY_CODE.fullmatch(code):
        raise ValueError("A currency is a three-letter code such as EUR.")
    return code


def _document_type(value: object) -> str:
    """Read the kind of document, defaulting to an invoice when the model said nothing."""
    text = _clean_text(value, 20)
    if text is None:
        return "invoice"
    normalised = text.lower().replace(" ", "_").replace("-", "_")
    if normalised not in DOCUMENT_TYPES:
        raise ValueError("A document is an invoice, a credit_note or a receipt.")
    return normalised


def _flag(value: object) -> bool | None:
    """Read a yes or no, or None when the model gave neither."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in {"true", "yes"}:
        return True
    if isinstance(value, str) and value.strip().lower() in {"false", "no"}:
        return False
    if isinstance(value, str) and value.strip().lower() in NOTHING:
        return None
    raise ValueError("This is true or false.")


type OptionalAmount = Annotated[Decimal | None, BeforeValidator(_amount)]


class LineItem(BaseModel):
    """One row of the invoice's table: what was bought, how many, at what price, and what the row comes to."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    description: Annotated[str, BeforeValidator(_description)] = ""
    quantity: OptionalAmount = None
    unit_price: OptionalAmount = None
    total: OptionalAmount = None


class VatLine(BaseModel):
    """One VAT rate of the invoice: the rate in percent, the amount it applies to (if printed) and the VAT charged."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    rate: OptionalAmount = None
    base: OptionalAmount = None
    amount: OptionalAmount = None


class ExtractedInvoice(BaseModel):
    """The fields of one invoice, credit note or receipt, as printed on it.

    Amounts are the ones printed, with their own sign. `prices_include_vat` is true for a receipt whose
    line prices already hold the VAT, which changes what the arithmetic must add up to.
    """

    model_config = ConfigDict(extra="ignore", frozen=True)

    document_type: Annotated[DocumentType, BeforeValidator(_document_type)] = "invoice"
    vendor: Annotated[str | None, BeforeValidator(_vendor)] = None
    invoice_number: Annotated[str | None, BeforeValidator(_number)] = None
    issue_date: Annotated[date | None, BeforeValidator(_day)] = None
    due_date: Annotated[date | None, BeforeValidator(_day)] = None
    currency: Annotated[str | None, BeforeValidator(_currency)] = None
    prices_include_vat: Annotated[bool | None, BeforeValidator(_flag)] = None
    line_items: Annotated[list[LineItem], Field(max_length=MAX_LINE_ITEMS)] = Field(default_factory=list)
    subtotal: OptionalAmount = None
    vat: Annotated[list[VatLine], Field(max_length=MAX_VAT_LINES)] = Field(default_factory=list)
    total: OptionalAmount = None

    @classmethod
    def from_reply(cls, data: dict[str, Any]) -> Self:
        """Build an invoice from a model's JSON object, refusing anything that doesn't fit."""
        return cls.model_validate(data)


class FieldPathError(ValueError):
    """A path names no field of the invoice, or the text given for it doesn't fit the field."""


# The fields a visitor may edit, by the kind of text each takes.
SCALAR_FIELDS = frozenset(
    {"vendor", "invoice_number", "issue_date", "due_date", "currency", "document_type", "subtotal", "total"}
)
LINE_FIELDS = frozenset({"description", "quantity", "unit_price", "total"})
VAT_FIELDS = frozenset({"rate", "base", "amount"})


def field_paths(invoice: ExtractedInvoice) -> list[str]:
    """List every field path the invoice has, in reading order: header, line items, subtotal, VAT lines, total."""
    paths = ["document_type", "vendor", "invoice_number", "issue_date", "due_date", "currency"]
    for index in range(len(invoice.line_items)):
        paths.extend(f"line_items.{index}.{name}" for name in ("description", "quantity", "unit_price", "total"))
    paths.append("subtotal")
    for index in range(len(invoice.vat)):
        paths.extend(f"vat.{index}.{name}" for name in ("rate", "base", "amount"))
    paths.append("total")
    return paths


def _split(path: str) -> tuple[str, int | None, str | None]:
    """Split a field path such as `vat.1.rate` into list name, index and field; a scalar's path is just its name."""
    if not FIELD_PATH.fullmatch(path):
        raise FieldPathError("This is not a field path.")
    parts = path.split(".")
    if len(parts) == 1:
        return parts[0], None, None
    return parts[0], int(parts[1]), parts[2]


def get_field(invoice: ExtractedInvoice, path: str) -> str | None:
    """Return a field's value as text, in the form the API and the exports write it, or None when it is empty."""
    name, index, field = _split(path)
    if index is None or field is None:
        if name not in SCALAR_FIELDS and name != "prices_include_vat":
            raise FieldPathError("This invoice has no such field.")
        return _as_text(getattr(invoice, name))
    rows: Sequence[LineItem | VatLine]
    if name == "line_items" and field in LINE_FIELDS:
        rows = invoice.line_items
    elif name == "vat" and field in VAT_FIELDS:
        rows = invoice.vat
    else:
        raise FieldPathError("This invoice has no such field.")
    if index >= len(rows):
        raise FieldPathError("This invoice has no such row.")
    return _as_text(getattr(rows[index], field), quantity=field == "quantity")


def _as_text(value: object, quantity: bool = False) -> str | None:
    """Write a field's value as the API shows it: amounts with two places, dates as ISO, flags as true or false."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        return quantity_text(value) if quantity else amount_text(value)
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def set_field(invoice: ExtractedInvoice, path: str, text: str) -> ExtractedInvoice:
    """Return the invoice with one field replaced by what a visitor typed, checked as a model's reply is.

    An empty text empties the field. Raises FieldPathError for a path the invoice doesn't have, and for
    text the field doesn't accept; the invoice itself is never changed.
    """
    name, index, field = _split(path)
    data = invoice.model_dump()
    if index is None or field is None:
        if name not in SCALAR_FIELDS:
            raise FieldPathError("This invoice has no such field.")
        data[name] = text
    else:
        key = "line_items" if name == "line_items" else "vat"
        allowed = LINE_FIELDS if key == "line_items" else VAT_FIELDS
        rows = data[key]
        if field not in allowed or index >= len(rows):
            raise FieldPathError("This invoice has no such field.")
        rows[index][field] = text
    try:
        return ExtractedInvoice.model_validate(data)
    except ValidationError:
        raise FieldPathError("This text doesn't fit the field.") from None
