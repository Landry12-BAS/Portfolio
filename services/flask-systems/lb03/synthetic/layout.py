"""Where every word of a synthetic invoice or receipt is printed: the page layouts the seed documents are drawn from.

A layout turns a document's printed truth (lb03/golden.py, `Printed`) into pages of `Run`s: a piece of
text, its position and size on the page, and, when it is the printed value of a field, that field's path
(`total`, `line_items.2.unit_price`). The same runs are drawn as a PDF (lb03/synthetic/pdf.py), turned into
a photograph (photo.py) or written out by hand (handwriting.py), and the runs that carry a field path are
what the field-box measurement is judged against. So a box in the manifest is where the value was really
printed, to the point, and not an estimate.

A page is measured by whatever draws it, through a `Measurer`, since a handwriting font is narrower and
wilder than Helvetica and right-aligned amounts must still end at the same edge.

Three invoice layouts (`classic`, `modern`, `compact`) and the narrow `receipt` differ in where things
are, which is the point: a reader that works only when the total is bottom right has not read anything.
This is development tooling; the service never imports it.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, Protocol

from lb03.golden import DateStyle, NumberStyle, Printed, PrintedLine, PrintedVat, Render
from lb03.money import cents, quantity_text

A4_WIDTH = 595.0
A4_HEIGHT = 842.0
RECEIPT_WIDTH = 226.0
RECEIPT_HEIGHT = 560.0
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
BUYER = ("Basalt & Bean Coffee Co.", "Roastery Lane 7", "602 00 Brno", "Czech Republic")
BUYER_TAX_ID = "CZ12345678"
type Anchor = Literal["left", "right", "center"]


@dataclass(frozen=True)
class Run:
    """A piece of text on a page: what it says, its top-left corner and size in points, its font, and its field."""

    text: str
    x: float
    y: float
    width: float
    height: float
    font: str
    size: float
    field: str | None = None


@dataclass(frozen=True)
class Rule:
    """A line or a filled rectangle: where it is, how thick, and how dark (0 black, 1 white)."""

    x0: float
    y0: float
    x1: float
    y1: float
    thickness: float = 0.6
    filled: bool = False
    gray: float = 0.0
    dashed: bool = False


@dataclass
class Page:
    """One page: its size, the text on it, the lines, and a word stamped across it."""

    width: float
    height: float
    runs: list[Run] = field(default_factory=list)
    rules: list[Rule] = field(default_factory=list)
    stamp: str | None = None


class Measurer(Protocol):
    """Whatever will draw a page, asked how wide a text comes out in a font at a size."""

    def width(self, text: str, font: str, size: float) -> float:
        """Return the width of `text` in points."""
        ...


class Builder:
    """Puts text and lines on a page, measuring as it goes, and keeps every run it placed."""

    def __init__(self, width: float, height: float, measurer: Measurer) -> None:
        """Start an empty page of this size, measured by `measurer`."""
        self.page = Page(width, height)
        self.measurer = measurer

    def text(
        self,
        x: float,
        y: float,
        text: str,
        font: str = "Helvetica",
        size: float = 9.0,
        anchor: Anchor = "left",
        field_path: str | None = None,
    ) -> Run:
        """Place a text with its top edge at `y` and its left, right or centre at `x`; return the run it became."""
        width = self.measurer.width(text, font, size)
        left = x if anchor == "left" else x - width if anchor == "right" else x - width / 2
        run = Run(text, left, y, width, size, font, size, field_path)
        self.page.runs.append(run)
        return run

    def rule(self, x0: float, y0: float, x1: float, y1: float, **options: float | bool) -> None:
        """Place a line, or with `filled=True` a rectangle."""
        self.page.rules.append(Rule(x0, y0, x1, y1, **options))  # type: ignore[arg-type]


@dataclass(frozen=True)
class Formats:
    """How a document writes its numbers and dates: the national habits that make amounts hard to read alike."""

    number_style: NumberStyle
    date_style: DateStyle

    def amount(self, value: Decimal) -> str:
        """Write an amount with two decimals, grouped the way this document groups them."""
        return group_number(cents(value), self.number_style)

    def quantity(self, value: Decimal) -> str:
        """Write a quantity: whole when it is whole, with its decimals when it has them, in this document's mark."""
        text = quantity_text(value)
        return text.replace(".", ",") if self.number_style != "en" else text

    def rate(self, value: Decimal) -> str:
        """Write a VAT rate in percent: `21%` in English, `21 %` where the space is the custom."""
        number = quantity_text(value)
        return f"{number}%" if self.number_style == "en" else f"{number.replace('.', ',')} %"

    def day(self, value: date) -> str:
        """Write a date in this document's style."""
        match self.date_style:
            case "iso":
                return value.isoformat()
            case "dmy_dots":
                return f"{value.day:02d}.{value.month:02d}.{value.year}"
            case "dmy_slashes":
                return f"{value.day:02d}/{value.month:02d}/{value.year}"
            case "text":
                return f"{value.day} {MONTHS[value.month - 1]} {value.year}"
            case "cs":
                return f"{value.day}. {value.month}. {value.year}"


def group_number(value: Decimal, style: NumberStyle) -> str:
    """Write a number with two decimals and its thousands grouped: `1,040.60`, `1.040,60` or `1 040,60`."""
    sign = "-" if value < 0 else ""
    whole, _, fraction = f"{abs(value):.2f}".partition(".")
    groups: list[str] = []
    while len(whole) > 3:
        groups.insert(0, whole[-3:])
        whole = whole[:-3]
    groups.insert(0, whole)
    joiner, mark = {"en": (",", "."), "de": (".", ","), "cs": (" ", ",")}[style]
    return f"{sign}{joiner.join(groups)}{mark}{fraction}"


def chunks[Item](items: list[Item], parts: int) -> list[list[Item]]:
    """Split a list into `parts` runs of nearly equal length, the earlier ones the longer, none empty when it can be."""
    size = math.ceil(len(items) / parts)
    return [items[start : start + size] for start in range(0, len(items), size)] or [[]]


TITLES = {"invoice": "INVOICE", "credit_note": "CREDIT NOTE", "receipt": "RECEIPT"}
NUMBER_LABELS = {"invoice": "Invoice no.", "credit_note": "Credit note no.", "receipt": "Receipt no."}


def fit(builder: Builder, text: str, font: str, size: float, available: float, minimum: float = 7.0) -> float:
    """Return the largest font size, from `size` down to `minimum`, at which `text` fits in `available` points."""
    current = size
    while current > minimum and builder.measurer.width(text, font, current) > available:
        current -= 0.5
    if builder.measurer.width(text, font, current) > available:
        raise ValueError(f"The text {text!r} does not fit in {available} points.")
    return current


def vat_total(printed: Printed) -> Decimal:
    """Add up the VAT the document prints."""
    return sum((line.amount for line in printed.vat), Decimal(0))


def _stamp_and_notice(builder: Builder, render: Render, last: bool) -> None:
    """Stamp the page with its word, and print the extra lines (the hostile text) at the foot of the last page."""
    page = builder.page
    if render.stamp:
        page.stamp = render.stamp
    if last:
        for index, line in enumerate(render.notice):
            builder.text(40, page.height - 52 + index * 9, line, "Helvetica", 6.5)


def _party_block(builder: Builder, x: float, y: float, lines: tuple[str, ...], first_field: str | None) -> None:
    """Print a name in bold and the address lines under it; the name carries the field when it has one."""
    builder.text(x, y, lines[0], "Helvetica-Bold", 10, field_path=first_field)
    for index, line in enumerate(lines[1:]):
        builder.text(x, y + 13 + index * 11, line, "Helvetica", 9)


# Where each invented vendor lives: a street, a town and a tax ID, so the same vendor always has the same address.
ADDRESSES = {
    "Bohemia Packaging s.r.o.": ("Dlouha 12", "110 00 Praha 1", "CZ27112233"),
    "Moravia Dairy Cooperative": ("Mlynska 4", "779 00 Olomouc", "CZ45678901"),
    "Brno Equipment Service s.r.o.": ("Strojirenska 21", "628 00 Brno", "CZ29876543"),
    "Hanseatic Green Coffee GmbH": ("Speicherstrasse 18", "20457 Hamburg", "DE812345678"),
    "Lowlands Roasting Supplies B.V.": ("Havenstraat 9", "3011 Rotterdam", "NL859123456B01"),
    "Tuscan Cup Company S.r.l.": ("Via Roma 31", "50123 Firenze", "IT01234567890"),
    "Iberia Sacks y Mas S.L.": ("Calle Mayor 7", "28013 Madrid", "ESB12345678"),
    "Highland Estates Coffee Inc.": ("400 Mountain Road", "Boulder CO 80302", "12-3456789"),
    "Thames Barista Supplies Ltd": ("Mill Lane 3", "London EC1A 1BB", "GB123456789"),
    "Aurora Bean Traders Ltd": ("Wharf Street 10", "Bristol BS1 4AA", "GB987654321"),
    "Cafe Luna": ("Namesti 5", "602 00 Brno", "CZ10101010"),
    "Corner Mart": ("Hlavni 8", "602 00 Brno", "CZ20202020"),
    "Stop and Go Fuel": ("Dalnicni 1", "664 42 Modrice", "CZ30303030"),
    "Pasta Fresca": ("Via Dolce 4", "34121 Trieste", "IT09876543210"),
}


def vendor_lines(printed: Printed) -> tuple[str, ...]:
    """Return the vendor's name, street, town and tax ID: its own address when it has one, else a made-up one."""
    street, town, tax_id = ADDRESSES.get(printed.vendor, ("Dlouha 99", "110 00 Praha 1", "CZ11111111"))
    return (printed.vendor, street, town, f"Tax ID {tax_id}")


def _row_description(
    builder: Builder,
    x: float,
    y: float,
    item: PrintedLine,
    path: str,
    width: float,
    size: float,
    font: str = "Helvetica",
) -> None:
    """Print a line item's description, shrunk to fit its column."""
    fitted = fit(builder, item.description, font, size, width)
    builder.text(x, y, item.description, font, fitted, field_path=path)


def classic(printed: Printed, render: Render, measurer: Measurer) -> list[Page]:
    """Lay out the classic invoice: vendor top left, title and number top right, a ruled table, totals bottom right."""
    formats = Formats(render.number_style, render.date_style)
    pages: list[Page] = []
    groups = chunks(list(enumerate(printed.line_items)), render.pages)
    for number, group in enumerate(groups):
        builder = Builder(A4_WIDTH, A4_HEIGHT, measurer)
        last = number == len(groups) - 1
        top = 40.0
        if number == 0:
            _classic_header(builder, printed, formats)
            top = 262.0
        else:
            builder.text(
                555, 36, f"{printed.vendor}  -  {printed.invoice_number}  -  page {number + 1}", "Helvetica", 8, "right"
            )
            top = 70.0
        builder.rule(40, top, 555, top, thickness=0.8)
        for text, x, anchor in (
            ("Description", 40, "left"),
            ("Qty", 340, "right"),
            ("Unit price", 440, "right"),
            ("Amount", 555, "right"),
        ):
            builder.text(x, top + 5, text, "Helvetica-Bold", 9, anchor)  # type: ignore[arg-type]
        builder.rule(40, top + 20, 555, top + 20, thickness=0.8)
        y = top + 28
        for index, item in group:
            _row_description(builder, 40, y, item, f"line_items.{index}.description", 270, 10)
            builder.text(
                340, y, formats.quantity(item.quantity), "Helvetica", 10, "right", f"line_items.{index}.quantity"
            )
            builder.text(
                440, y, formats.amount(item.unit_price), "Helvetica", 10, "right", f"line_items.{index}.unit_price"
            )
            builder.text(555, y, formats.amount(item.total), "Helvetica", 10, "right", f"line_items.{index}.total")
            y += 20
        builder.rule(40, y + 2, 555, y + 2, thickness=0.4)
        if last:
            _classic_totals(builder, printed, formats, y + 14)
        else:
            builder.text(555, y + 12, "Continued on the next page", "Helvetica-Oblique", 8, "right")
        _stamp_and_notice(builder, render, last)
        pages.append(builder.page)
    return pages


def _classic_header(builder: Builder, printed: Printed, formats: Formats) -> None:
    """Print the first page's header: who is selling, what this is, its number and dates, and who is buying."""
    lines = vendor_lines(printed)
    builder.text(40, 40, lines[0], "Helvetica-Bold", 15, field_path="vendor")
    for index, line in enumerate(lines[1:]):
        builder.text(40, 62 + index * 11, line, "Helvetica", 9)
    builder.text(555, 40, TITLES[printed.document_type], "Helvetica-Bold", 22, "right")
    builder.text(470, 76, NUMBER_LABELS[printed.document_type], "Helvetica", 9, "right")
    builder.text(555, 74, printed.invoice_number, "Helvetica-Bold", 11, "right", "invoice_number")
    rows = [("Date of issue", formats.day(printed.issue_date), "issue_date")]
    if printed.due_date is not None:
        rows.append(("Due date", formats.day(printed.due_date), "due_date"))
    rows.append(("Currency", printed.currency, "currency"))
    for index, (label, value, path) in enumerate(rows):
        builder.text(470, 104 + index * 15, label, "Helvetica", 9, "right")
        builder.text(555, 103 + index * 15, value, "Helvetica", 10, "right", path)
    builder.text(40, 150, "Bill to", "Helvetica-Bold", 9)
    _party_block(builder, 40, 164, (*BUYER, f"Tax ID {BUYER_TAX_ID}"), None)


def _vat_table(
    builder: Builder,
    printed: Printed,
    formats: Formats,
    x_rate: float,
    x_base: float,
    x_vat: float,
    y: float,
    mono: bool = False,
) -> float:
    """Print the VAT summary, a row for each rate, and return the y below it."""
    if not printed.vat:
        return y
    plain, bold = ("Courier", "Courier-Bold") if mono else ("Helvetica", "Helvetica-Bold")
    builder.text(x_rate, y, "VAT rate", bold, 8)
    builder.text(x_base, y, "Base", bold, 8, "right")
    builder.text(x_vat, y, "VAT", bold, 8, "right")
    y += 13
    for index, line in enumerate(printed.vat):
        builder.text(x_rate, y, formats.rate(line.rate), plain, 9, "left", f"vat.{index}.rate")
        if line.base is not None:
            builder.text(x_base, y, formats.amount(line.base), plain, 9, "right", f"vat.{index}.base")
        builder.text(x_vat, y, formats.amount(line.amount), plain, 9, "right", f"vat.{index}.amount")
        y += 13
    return y


def _classic_totals(builder: Builder, printed: Printed, formats: Formats, y: float) -> None:
    """Print the VAT summary on the left and the subtotal and the total on the right, then the payment footer."""
    bottom = _vat_table(builder, printed, formats, 40, 150, 240, y)
    if printed.subtotal is not None:
        builder.text(470, y, "Subtotal", "Helvetica", 10, "right")
        builder.text(555, y, formats.amount(printed.subtotal), "Helvetica", 10, "right", "subtotal")
        y += 18
    builder.rule(380, y, 555, y, thickness=0.8)
    builder.text(440, y + 8, "Total due", "Helvetica-Bold", 12, "right")
    builder.text(555, y + 8, formats.amount(printed.total), "Helvetica-Bold", 12, "right", "total")
    builder.text(342, y + 9, printed.currency, "Helvetica", 9, "right")
    footer = max(bottom, y + 40) + 30
    builder.text(
        40,
        footer,
        "Payment by bank transfer within the due date. Bank: First Fictional Bank, IBAN XX00 0000 0000 0000 0000.",
        "Helvetica",
        8,
    )
    builder.text(
        40,
        footer + 11,
        "Goods remain the property of the seller until paid in full. Questions: accounts@example.invalid",
        "Helvetica",
        8,
    )


def modern(printed: Printed, render: Render, measurer: Measurer) -> list[Page]:
    """Lay out the modern invoice: a grey bar, the facts in small captions, an unlined table, totals bottom left."""
    formats = Formats(render.number_style, render.date_style)
    pages: list[Page] = []
    groups = chunks(list(enumerate(printed.line_items)), render.pages)
    for number, group in enumerate(groups):
        builder = Builder(A4_WIDTH, A4_HEIGHT, measurer)
        last = number == len(groups) - 1
        builder.rule(0, 0, 26, A4_HEIGHT, filled=True, gray=0.9)
        top = 60.0
        if number == 0:
            lines = vendor_lines(printed)
            builder.text(60, 44, lines[0], "Helvetica-Bold", 18, field_path="vendor")
            builder.text(60, 68, f"{lines[1]}, {lines[2]}", "Helvetica", 8)
            builder.text(60, 79, lines[3], "Helvetica", 8)
            builder.text(555, 46, TITLES[printed.document_type].title(), "Helvetica-Bold", 16, "right")
            captions = [
                ("NUMBER", printed.invoice_number, "invoice_number"),
                ("ISSUED", formats.day(printed.issue_date), "issue_date"),
            ]
            if printed.due_date is not None:
                captions.append(("DUE", formats.day(printed.due_date), "due_date"))
            captions.append(("CURRENCY", printed.currency, "currency"))
            for index, (caption, value, path) in enumerate(captions):
                x = 60 + index * 125
                builder.text(x, 120, caption, "Helvetica", 7)
                builder.text(x, 131, value, "Helvetica-Bold", 11, field_path=path)
            builder.text(60, 170, "BILLED TO", "Helvetica", 7)
            _party_block(builder, 60, 181, BUYER, None)
            top = 262.0
        else:
            builder.text(
                555, 36, f"{printed.vendor} / {printed.invoice_number} / page {number + 1}", "Helvetica", 8, "right"
            )
        builder.rule(60, top, 555, top + 18, filled=True, gray=0.93)
        for text, x, anchor in (
            ("ITEM", 66, "left"),
            ("QTY", 360, "right"),
            ("PRICE", 455, "right"),
            ("TOTAL", 549, "right"),
        ):
            builder.text(x, top + 5, text, "Helvetica-Bold", 8, anchor)  # type: ignore[arg-type]
        y = top + 28
        for index, item in group:
            _row_description(builder, 66, y, item, f"line_items.{index}.description", 270, 10)
            builder.text(
                360, y, formats.quantity(item.quantity), "Helvetica", 10, "right", f"line_items.{index}.quantity"
            )
            builder.text(
                455, y, formats.amount(item.unit_price), "Helvetica", 10, "right", f"line_items.{index}.unit_price"
            )
            builder.text(549, y, formats.amount(item.total), "Helvetica", 10, "right", f"line_items.{index}.total")
            builder.rule(60, y + 16, 555, y + 16, thickness=0.3, gray=0.7)
            y += 22
        if last:
            _modern_totals(builder, printed, formats, y + 18)
        _stamp_and_notice(builder, render, last)
        pages.append(builder.page)
    return pages


def _modern_totals(builder: Builder, printed: Printed, formats: Formats, y: float) -> None:
    """Print the totals bottom left: the VAT summary, the subtotal, and the total due in a large type."""
    y = _vat_table(builder, printed, formats, 66, 190, 280, y) + 8
    if printed.subtotal is not None:
        builder.text(66, y, "SUBTOTAL", "Helvetica", 8)
        builder.text(280, y - 1, formats.amount(printed.subtotal), "Helvetica", 10, "right", "subtotal")
        y += 18
    builder.text(66, y, "TOTAL DUE", "Helvetica-Bold", 9)
    builder.text(160, y - 1, printed.currency, "Helvetica", 10, "right")
    builder.text(280, y - 3, formats.amount(printed.total), "Helvetica-Bold", 14, "right", "total")
    builder.text(
        60, y + 50, "Thank you for your business. Payment terms are as agreed in the supply contract.", "Helvetica", 8
    )


def compact(printed: Printed, render: Render, measurer: Measurer) -> list[Page]:
    """Lay out the compact invoice: eight-point monospaced type, the facts on one line, dense columns."""
    formats = Formats(render.number_style, render.date_style)
    pages: list[Page] = []
    groups = chunks(list(enumerate(printed.line_items)), render.pages)
    for number, group in enumerate(groups):
        builder = Builder(A4_WIDTH, A4_HEIGHT, measurer)
        last = number == len(groups) - 1
        y = 40.0
        if number == 0:
            builder.text(36, y, printed.vendor, "Courier-Bold", 11, field_path="vendor")
            for index, line in enumerate(vendor_lines(printed)[1:]):
                builder.text(36, y + 15 + index * 10, line, "Courier", 8)
            y += 60
            builder.text(36, y, TITLES[printed.document_type] + " " + "-" * 20, "Courier-Bold", 9)
            y += 16
            x = 36.0
            parts = [
                (NUMBER_LABELS[printed.document_type] + ":", printed.invoice_number, "invoice_number"),
                ("Date:", formats.day(printed.issue_date), "issue_date"),
            ]
            if printed.due_date is not None:
                parts.append(("Due:", formats.day(printed.due_date), "due_date"))
            parts.append(("Currency:", printed.currency, "currency"))
            for label, value, path in parts:
                run = builder.text(x, y, label, "Courier", 8)
                value_run = builder.text(x + run.width + 5, y, value, "Courier-Bold", 8, field_path=path)
                x = value_run.x + value_run.width + 18
            y += 28
            builder.text(36, y, "Buyer: " + ", ".join(BUYER[:3]), "Courier", 8)
            y += 24
        else:
            builder.text(36, y, f"{printed.vendor} {printed.invoice_number} page {number + 1}", "Courier", 8)
            y += 24
        for text, x, anchor in (
            ("Item", 36, "left"),
            ("Qty", 330, "right"),
            ("Price", 430, "right"),
            ("Total", 559, "right"),
        ):
            builder.text(x, y, text, "Courier-Bold", 8, anchor)  # type: ignore[arg-type]
        builder.rule(36, y + 11, 559, y + 11, thickness=0.4, dashed=True)
        y += 17
        for index, item in group:
            _row_description(builder, 36, y, item, f"line_items.{index}.description", 270, 8, "Courier")
            builder.text(330, y, formats.quantity(item.quantity), "Courier", 8, "right", f"line_items.{index}.quantity")
            builder.text(
                430, y, formats.amount(item.unit_price), "Courier", 8, "right", f"line_items.{index}.unit_price"
            )
            builder.text(559, y, formats.amount(item.total), "Courier", 8, "right", f"line_items.{index}.total")
            y += 13
        builder.rule(36, y + 2, 559, y + 2, thickness=0.4, dashed=True)
        if last:
            y += 14
            y = _vat_table(builder, printed, formats, 36, 150, 240, y, mono=True) + 6
            if printed.subtotal is not None:
                builder.text(430, y, "Subtotal", "Courier", 8, "right")
                builder.text(559, y, formats.amount(printed.subtotal), "Courier", 8, "right", "subtotal")
                y += 12
            builder.text(430, y, "TOTAL " + printed.currency, "Courier-Bold", 9, "right")
            builder.text(559, y, formats.amount(printed.total), "Courier-Bold", 9, "right", "total")
        _stamp_and_notice(builder, render, last)
        pages.append(builder.page)
    return pages


def receipt(
    printed: Printed,
    render: Render,
    measurer: Measurer,
    font: str = "Courier",
    bold: str = "Courier-Bold",
    scale: float = 1.0,
) -> list[Page]:
    """Lay out the narrow till receipt: the shop centred, one line a purchase, the VAT, the total; on one page.

    `font` and `bold` and `scale` let the handwriting renderer print the same receipt in its own type.
    """
    formats = Formats(render.number_style, render.date_style)
    builder = Builder(RECEIPT_WIDTH, RECEIPT_HEIGHT, measurer)
    centre = RECEIPT_WIDTH / 2
    size = 8.5 * scale
    y = 20.0
    lines = vendor_lines(printed)
    builder.text(centre, y, printed.vendor, bold, 11 * scale, "center", "vendor")
    y += 18 * scale
    for line in lines[1:3]:
        builder.text(centre, y, line, font, 7.5 * scale, "center")
        y += 10 * scale
    y += 8
    label = builder.text(14, y, NUMBER_LABELS["receipt"], font, size)
    builder.text(14 + label.width + 5, y, printed.invoice_number, bold, size, field_path="invoice_number")
    y += 13 * scale
    day = builder.text(14, y, formats.day(printed.issue_date), font, size, field_path="issue_date")
    builder.text(14 + day.width + 12, y, "10:42", font, size)
    y += 18 * scale
    builder.rule(12, y - 4, RECEIPT_WIDTH - 12, y - 4, thickness=0.5, dashed=True)
    for index, item in enumerate(printed.line_items):
        quantity = builder.text(
            14, y, formats.quantity(item.quantity), font, size, field_path=f"line_items.{index}.quantity"
        )
        multiply = builder.text(14 + quantity.width + 3, y, "x", font, size)
        description_x = multiply.x + multiply.width + 5
        room = RECEIPT_WIDTH - 14 - description_x - 62 * scale
        _receipt_description(builder, description_x, y, item, index, font, size, room)
        builder.text(
            RECEIPT_WIDTH - 14, y, formats.amount(item.total), font, size, "right", f"line_items.{index}.total"
        )
        y += 11 * scale
        price = "@ " + formats.amount(item.unit_price)
        builder.text(description_x, y, price[:2], font, 6.5 * scale)
        builder.text(
            description_x + builder.measurer.width("@ ", font, 6.5 * scale),
            y,
            price[2:],
            font,
            6.5 * scale,
            field_path=f"line_items.{index}.unit_price",
        )
        y += 14 * scale
    builder.rule(12, y - 2, RECEIPT_WIDTH - 12, y - 2, thickness=0.5, dashed=True)
    y += 8
    for index, vat in enumerate(printed.vat):
        _receipt_vat(builder, formats, vat, index, y, font, 7.5 * scale)
        y += 11 * scale
    y += 8
    builder.text(14, y, "TOTAL", bold, 11 * scale)
    builder.text(RECEIPT_WIDTH - 14, y, formats.amount(printed.total), bold, 11 * scale, "right", "total")
    builder.text(
        RECEIPT_WIDTH - 14 - builder.measurer.width(formats.amount(printed.total), bold, 11 * scale) - 6,
        y + 2,
        printed.currency,
        font,
        8 * scale,
        "right",
        "currency",
    )
    y += 22 * scale
    builder.text(centre, y, "Thank you, see you again", font, 7.5 * scale, "center")
    # A receipt is as long as what is on it, plus a margin, and a few lines for any notice printed at the foot.
    builder.page.height = y + 36 + 9 * len(render.notice)
    _stamp_and_notice(builder, render, True)
    return [builder.page]


def _receipt_description(
    builder: Builder, x: float, y: float, item: PrintedLine, index: int, font: str, size: float, room: float
) -> None:
    """Print a receipt line's description, shrunk to the room it has."""
    fitted = fit(builder, item.description, font, size, room, minimum=5.0)
    builder.text(x, y, item.description, font, fitted, field_path=f"line_items.{index}.description")


def _receipt_vat(
    builder: Builder, formats: Formats, vat: PrintedVat, index: int, y: float, font: str, size: float
) -> None:
    """Print one VAT summary row of a receipt: the rate, what it applies to, and the VAT."""
    label = builder.text(14, y, "VAT", font, size)
    rate = builder.text(14 + label.width + 5, y, formats.rate(vat.rate), font, size, field_path=f"vat.{index}.rate")
    x = rate.x + rate.width + 10
    if vat.base is not None:
        base_label = builder.text(x, y, "base", font, size)
        base = builder.text(
            x + base_label.width + 4, y, formats.amount(vat.base), font, size, field_path=f"vat.{index}.base"
        )
        x = base.x + base.width + 10
    builder.text(RECEIPT_WIDTH - 14, y, formats.amount(vat.amount), font, size, "right", f"vat.{index}.amount")


LAYOUTS: dict[str, Callable[[Printed, Render, Measurer], list[Page]]] = {
    "classic": classic,
    "modern": modern,
    "compact": compact,
    "receipt": receipt,
}
ROUNDING = ROUND_HALF_UP
