"""The box rule: given words with boxes, which words print each field, and how sure the service is.

The words are made up here, laid out like a page: rows of words at heights, columns at positions. That lets each
test set up one situation (a total printed twice, a quantity of 1 in every row, a page turned three degrees, a
number with one digit misread) and say exactly what the rule must pick. How well it does on real OCR of the
synthetic documents is measured, not tested (`just ocr-lb03`).
"""

import math
from datetime import date
from decimal import Decimal

import pytest

from lb03.boxes import (
    PageWords,
    Placement,
    date_texts,
    is_split_thousands,
    normalise,
    one_digit_substituted,
    place_fields,
)
from lb03.invoice import ExtractedInvoice
from tests.lb03_support import LETTER_WIDTH, page, row, sentence


def invoice(**fields: object) -> ExtractedInvoice:
    """Make an extracted invoice from the fields a test names."""
    return ExtractedInvoice.model_validate(fields)


def placed(found: dict[str, Placement], path: str) -> Placement:
    """Return a field's placement, failing if it has none."""
    assert path in found, f"{path} was not placed; placed: {sorted(found)}"
    return found[path]


def near(placement: Placement, x: float, y: float) -> bool:
    """Tell whether a placement's first corner is at a position, within a hair."""
    return abs(placement.quad[0] - x) < 0.002 and abs(placement.quad[1] - y) < 0.002


def simple_invoice_page() -> PageWords:
    """Make a small invoice as OCR would return it: header, two table rows, a subtotal, VAT and a total."""
    return page(
        row(0.05, ("Bohemia", 0.07), ("Packaging", 0.15), ("s.r.o.", 0.27)),
        row(0.09, ("Invoice", 0.60), ("no.", 0.69), ("2026-0412", 0.75)),
        row(0.12, ("Issued", 0.60), ("12.04.2026", 0.75)),
        row(0.14, ("Due", 0.60), ("12.05.2026", 0.75)),
        row(0.16, ("Currency", 0.60), ("EUR", 0.75)),
        row(0.30, ("Description", 0.07), ("Qty", 0.55), ("Unit", 0.67), ("Total", 0.85)),
        row(0.34, ("Kraft", 0.07), ("boxes", 0.13), ("1", 0.56), ("7.40", 0.67), ("7.40", 0.86)),
        row(0.36, ("Tape", 0.07), ("rolls", 0.12), ("1", 0.56), ("12.00", 0.66), ("12.00", 0.85)),
        row(0.40, ("Subtotal", 0.70), ("19.40", 0.85)),
        row(0.42, ("VAT", 0.07), ("21%", 0.20), ("19.40", 0.30), ("4.07", 0.45)),
        row(0.45, ("Total", 0.70), ("23.47", 0.85)),
    )


def test_every_field_of_a_simple_invoice_is_found_in_its_place() -> None:
    """Header, rows, subtotal, VAT and total each get the words printed at their position."""
    reading = invoice(
        vendor="Bohemia Packaging s.r.o.",
        invoice_number="2026-0412",
        issue_date="2026-04-12",
        due_date="2026-05-12",
        currency="EUR",
        line_items=[
            {"description": "Kraft boxes", "quantity": "1", "unit_price": "7.40", "total": "7.40"},
            {"description": "Tape rolls", "quantity": "1", "unit_price": "12.00", "total": "12.00"},
        ],
        subtotal="19.40",
        vat=[{"rate": "21", "base": "19.40", "amount": "4.07"}],
        total="23.47",
    )
    found = place_fields(reading, [simple_invoice_page()])
    assert near(placed(found, "vendor"), 0.07, 0.05)
    assert near(placed(found, "invoice_number"), 0.75, 0.09)
    assert near(placed(found, "issue_date"), 0.75, 0.12)
    assert near(placed(found, "due_date"), 0.75, 0.14)
    assert near(placed(found, "currency"), 0.75, 0.16)
    assert near(placed(found, "line_items.0.description"), 0.07, 0.34)
    assert near(placed(found, "line_items.0.quantity"), 0.56, 0.34)
    assert near(placed(found, "line_items.0.unit_price"), 0.67, 0.34)
    assert near(placed(found, "line_items.0.total"), 0.86, 0.34)
    assert near(placed(found, "line_items.1.description"), 0.07, 0.36)
    assert near(placed(found, "line_items.1.unit_price"), 0.66, 0.36)
    assert near(placed(found, "line_items.1.total"), 0.85, 0.36)
    assert near(placed(found, "subtotal"), 0.85, 0.40)
    assert near(placed(found, "vat.0.rate"), 0.20, 0.42)
    assert near(placed(found, "vat.0.base"), 0.30, 0.42)
    assert near(placed(found, "vat.0.amount"), 0.45, 0.42)
    assert near(placed(found, "total"), 0.85, 0.45)


def test_a_field_of_one_page_is_placed_on_that_page() -> None:
    """The placement says which page the words are on, for a document of several."""
    first = page(sentence(0.1, 0.1, "Bohemia Packaging"), number=1)
    second = page(row(0.1, ("Total", 0.6), ("99.00", 0.8)), number=2)
    found = place_fields(invoice(vendor="Bohemia Packaging", total="99.00"), [first, second])
    assert placed(found, "vendor").page == 1
    assert placed(found, "total").page == 2


def test_confidence_is_the_ocr_confidence_times_the_match_quality() -> None:
    """A perfect match on words of confidence 0.8 is 0.8, and a match of 0.6 quality on the same words is 0.48."""
    exact = page(row(0.1, ("Total", 0.6), ("23.47", 0.8), confidence=0.8))
    found = place_fields(invoice(total="23.47"), [exact])
    assert placed(found, "total").match == 1.0
    assert placed(found, "total").confidence == pytest.approx(0.8)
    off_by_a_digit = page(row(0.1, ("Total", 0.6), ("23.41", 0.8), confidence=0.8))
    found = place_fields(invoice(total="23.47"), [off_by_a_digit])
    assert placed(found, "total").match == 0.6
    assert placed(found, "total").confidence == pytest.approx(0.48)


def test_the_confidence_of_several_words_is_their_mean() -> None:
    """A vendor name of three words with confidences 0.9, 0.8 and 1.0 has a mean confidence of 0.9."""
    words = [
        word.model_copy(update={"confidence": confidence})
        for word, confidence in zip(sentence(0.1, 0.1, "Bohemia Packaging s.r.o."), (0.9, 0.8, 1.0), strict=True)
    ]
    found = place_fields(invoice(vendor="Bohemia Packaging s.r.o."), [PageWords(1, words)])
    assert placed(found, "vendor").confidence == pytest.approx(0.9)


@pytest.mark.parametrize(
    ("printed", "value"),
    [
        ("1,040.60", "1040.60"),
        ("1.040,60", "1040.60"),
        ("1040.60", "1040.60"),
        ("1040,60", "1040.60"),
        ("EUR1,040.60", "1040.60"),
        ("1,040.60EUR", "1040.60"),
        ("(250.00)", "-250.00"),
        ("-250.00", "-250.00"),
    ],
)
def test_an_amount_is_found_however_it_is_written(printed: str, value: str) -> None:
    """The rule reads each word as a number the way a person would, and compares the value."""
    found = place_fields(invoice(total=value), [page(row(0.1, ("Total", 0.6), (printed, 0.8)))])
    assert placed(found, "total").match == 1.0


def test_an_amount_with_a_space_as_its_thousands_mark_is_two_words_and_one_amount() -> None:
    """`1 040,60` comes back from OCR as two words; together they are the amount, and the box covers both."""
    reading = page(row(0.1, ("Total", 0.6), ("1", 0.80), ("040,60", 0.82)))
    found = place_fields(invoice(total="1040.60"), [reading])
    total = placed(found, "total")
    assert total.match == 1.0
    assert total.quad[0] < 0.81 < total.quad[2]
    assert total.quad[2] > 0.82 + 0.05


def test_two_numbers_side_by_side_in_a_table_are_not_joined_into_one_amount() -> None:
    """A quantity of 2 beside a price of 7.40 must not read as 27.40."""
    reading = page(row(0.1, ("2", 0.60), ("7.40", 0.65)))
    assert place_fields(invoice(total="27.40"), [reading]) == {}


def test_the_same_digits_with_the_other_sign_still_point_at_the_place() -> None:
    """A credit note printed as 250.00 and extracted as -250.00 is found, with a lower match."""
    found = place_fields(invoice(total="-250.00"), [page(row(0.1, ("Total", 0.6), ("250.00", 0.8)))])
    assert placed(found, "total").match == pytest.approx(0.9)


def test_one_misread_digit_is_found_with_a_lower_match_and_a_short_number_is_not() -> None:
    """A number of four digits or more with one digit out is a near miss; a shorter one is a different number."""
    long = place_fields(invoice(total="1040.60"), [page(row(0.1, ("1040.68", 0.8)))])
    assert placed(long, "total").match == 0.6
    short = place_fields(invoice(total="7.40"), [page(row(0.1, ("7.41", 0.8)))])
    assert "total" not in short


def test_a_missing_or_an_extra_digit_is_a_different_number_not_a_misreading() -> None:
    """Dropping a digit would make 27.40 out of 7.40, so a missing digit is not forgiven."""
    assert place_fields(invoice(total="1040.60"), [page(row(0.1, ("104.60", 0.8)))]) == {}
    assert place_fields(invoice(total="1040.60"), [page(row(0.1, ("10400.60", 0.8)))]) == {}


def test_a_value_that_is_not_on_the_page_has_no_box() -> None:
    """A made-up total, or a vendor the page never names, is not placed: the board says it was not found."""
    found = place_fields(invoice(vendor="Acme Widgets Ltd", total="999.99"), [simple_invoice_page()])
    assert found == {}


@pytest.mark.parametrize(
    "written",
    ["2026-04-12", "12.04.2026", "12.4.2026", "12/04/2026", "12 Apr 2026", "12 April 2026", "April 12, 2026"],
)
def test_a_date_is_found_in_the_usual_ways_it_is_written(written: str) -> None:
    """ISO, dots, slashes, month names and the English month-first form all match the same date."""
    cells = []
    x = 0.6
    for part in written.split(" "):
        cells.append((part, x))
        x += LETTER_WIDTH * len(part) + 0.012
    found = place_fields(invoice(issue_date="2026-04-12"), [page(row(0.1, ("Date", 0.5), *cells))])
    assert placed(found, "issue_date").match == 1.0


def test_the_czech_date_with_spaces_after_the_dots_is_three_words_and_one_date() -> None:
    """`12. 4. 2026` is read as one date, and the box covers the three words."""
    reading = page(row(0.1, ("12.", 0.6), ("4.", 0.64), ("2026", 0.67)))
    found = place_fields(invoice(issue_date="2026-04-12"), [reading])
    date_box = placed(found, "issue_date")
    assert date_box.quad[0] < 0.61
    assert date_box.quad[2] > 0.70


def test_a_date_one_character_out_is_a_near_miss_and_a_different_date_is_not_found() -> None:
    """OCR that reads 12.04.2026 as 12.04.2O26 is still found, at a lower match; 13.04.2026 is another day."""
    close = place_fields(invoice(issue_date="2026-04-12"), [page(row(0.1, ("12.04.2O26", 0.6)))])
    assert 0.9 <= placed(close, "issue_date").match < 1.0
    other = place_fields(invoice(issue_date="2026-04-12"), [page(row(0.1, ("13.04.2026", 0.6)))])
    assert other == {}


def test_the_two_dates_of_an_invoice_are_two_different_places() -> None:
    """The issue date and the due date never claim the same words, even when written the same way."""
    reading = page(row(0.1, ("12.04.2026", 0.6)), row(0.14, ("12.04.2026", 0.6)))
    found = place_fields(invoice(issue_date="2026-04-12", due_date="2026-04-12"), [reading])
    assert placed(found, "issue_date").quad != placed(found, "due_date").quad
    assert near(placed(found, "issue_date"), 0.6, 0.1)
    assert near(placed(found, "due_date"), 0.6, 0.14)


@pytest.mark.parametrize(
    ("mark", "currency"), [("EUR", "EUR"), ("€", "EUR"), ("CZK", "CZK"), ("Kč", "CZK"), ("$", "USD")]
)
def test_a_currency_is_its_code_or_its_symbol(mark: str, currency: str) -> None:
    """The code and the sign both point at the currency."""
    found = place_fields(invoice(currency=currency), [page(row(0.1, ("Amount", 0.5), (mark, 0.7)))])
    assert placed(found, "currency").match == 1.0


def test_a_total_printed_twice_is_placed_at_the_lowest_and_the_subtotal_above_it() -> None:
    """A summary box at the top repeats the total: the foot's is the total, and the subtotal is the one above it."""
    reading = page(
        row(0.10, ("Amount", 0.60), ("due", 0.70), ("23.47", 0.85)),
        row(0.40, ("Subtotal", 0.70), ("19.40", 0.85)),
        row(0.45, ("Total", 0.70), ("23.47", 0.85)),
    )
    found = place_fields(invoice(subtotal="19.40", total="23.47"), [reading])
    assert near(placed(found, "total"), 0.85, 0.45)
    assert near(placed(found, "subtotal"), 0.85, 0.40)


def test_the_total_and_the_subtotal_never_share_a_word() -> None:
    """With no VAT the subtotal and the total are the same number; printed once, only the total gets it."""
    reading = page(row(0.45, ("Total", 0.70), ("19.40", 0.85)))
    found = place_fields(invoice(subtotal="19.40", total="19.40"), [reading])
    assert "total" in found
    assert "subtotal" not in found


def test_a_quantity_of_one_in_every_row_is_taken_from_its_own_row() -> None:
    """The quantity of each item is the 1 in that item's row, not the first 1 on the page."""
    reading = page(
        row(0.34, ("Boxes", 0.07), ("1", 0.56), ("7.40", 0.67), ("7.40", 0.86)),
        row(0.36, ("Tape", 0.07), ("1", 0.56), ("12.00", 0.66), ("12.00", 0.85)),
        row(0.38, ("Labels", 0.07), ("1", 0.56), ("3.10", 0.67), ("3.10", 0.86)),
    )
    items = [
        {"description": "Boxes", "quantity": "1", "unit_price": "7.40", "total": "7.40"},
        {"description": "Tape", "quantity": "1", "unit_price": "12.00", "total": "12.00"},
        {"description": "Labels", "quantity": "1", "unit_price": "3.10", "total": "3.10"},
    ]
    found = place_fields(invoice(line_items=items), [reading])
    for index, y in enumerate((0.34, 0.36, 0.38)):
        assert abs(placed(found, f"line_items.{index}.quantity").quad[1] - y) < 0.002
        assert abs(placed(found, f"line_items.{index}.total").quad[1] - y) < 0.002


def test_a_unit_price_equal_to_the_row_total_gets_the_left_word_and_the_total_the_right() -> None:
    """When quantity is 1 the price and the total are the same number twice; the columns decide which is which."""
    reading = page(row(0.34, ("Boxes", 0.07), ("7.40", 0.67), ("7.40", 0.86)))
    items = [{"description": "Boxes", "unit_price": "7.40", "total": "7.40"}]
    found = place_fields(invoice(line_items=items), [reading])
    assert near(placed(found, "line_items.0.unit_price"), 0.67, 0.34)
    assert near(placed(found, "line_items.0.total"), 0.86, 0.34)


def test_two_rows_with_the_same_description_are_taken_in_order() -> None:
    """Two lines that read the same are the first and the second item, top to bottom."""
    reading = page(
        row(0.34, ("Freight", 0.07), ("240.00", 0.85)),
        row(0.36, ("Freight", 0.07), ("240.00", 0.85)),
    )
    items = [{"description": "Freight", "total": "240.00"}, {"description": "Freight", "total": "240.00"}]
    found = place_fields(invoice(line_items=items), [reading])
    assert abs(placed(found, "line_items.0.description").quad[1] - 0.34) < 0.002
    assert abs(placed(found, "line_items.1.description").quad[1] - 0.36) < 0.002
    assert abs(placed(found, "line_items.1.total").quad[1] - 0.36) < 0.002


def test_a_row_below_stands_in_when_the_numbers_are_printed_a_line_lower() -> None:
    """Some layouts print the amounts on the line under the description: the next row is used when the row has none."""
    reading = page(
        row(0.34, ("Green", 0.07), ("coffee", 0.13)),
        row(0.355, ("7.40", 0.85)),
        row(0.40, ("Total", 0.70), ("7.40", 0.85)),
    )
    items = [{"description": "Green coffee", "total": "7.40"}]
    found = place_fields(invoice(line_items=items, total="7.40"), [reading])
    assert abs(placed(found, "line_items.0.total").quad[1] - 0.355) < 0.002
    assert abs(placed(found, "total").quad[1] - 0.40) < 0.002


def test_a_description_wrapped_over_two_lines_is_found_by_its_first_line() -> None:
    """When OCR returns the first line only of a long description, it is placed with a lower match."""
    reading = page(
        row(0.34, ("Green", 0.07), ("coffee", 0.13), ("Ethiopia", 0.19)), row(0.355, ("Guji", 0.07), ("60", 0.12))
    )
    items = [{"description": "Green coffee Ethiopia Guji 60 kg bag"}]
    found = place_fields(invoice(line_items=items), [reading])
    description = placed(found, "line_items.0.description")
    assert 0.5 <= description.match < 1.0


def test_vat_rows_are_placed_in_order_after_the_items() -> None:
    """Each VAT row's rate, base and amount come from one row, and the rows are taken top to bottom."""
    reading = page(
        row(0.34, ("Goods", 0.07), ("100.00", 0.85)),
        row(0.45, ("0", 0.07), ("%", 0.10), ("45.00", 0.30), ("0.00", 0.45)),
        row(0.47, ("7", 0.07), ("%", 0.09), ("100.00", 0.29), ("7.00", 0.45)),
        row(0.49, ("19", 0.07), ("%", 0.10), ("45.00", 0.30), ("8.55", 0.45)),
    )
    vat = [
        {"rate": "0", "base": "45.00", "amount": "0.00"},
        {"rate": "7", "base": "100.00", "amount": "7.00"},
        {"rate": "19", "base": "45.00", "amount": "8.55"},
    ]
    found = place_fields(invoice(line_items=[{"description": "Goods", "total": "100.00"}], vat=vat), [reading])
    for index, y in enumerate((0.45, 0.47, 0.49)):
        for name in ("rate", "base", "amount"):
            assert abs(placed(found, f"vat.{index}.{name}").quad[1] - y) < 0.002, (index, name)
    assert abs(placed(found, "line_items.0.total").quad[1] - 0.34) < 0.002


def test_the_percent_sign_is_part_of_the_rate_box() -> None:
    """`21` and `%` as two words are one rate, and the box covers both."""
    reading = page(row(0.45, ("21", 0.07), ("%", 0.10), ("19.40", 0.30)))
    found = place_fields(invoice(vat=[{"rate": "21", "base": "19.40"}]), [reading])
    rate = placed(found, "vat.0.rate")
    assert rate.quad[2] > 0.10 + 0.005


@pytest.mark.parametrize("tilt_degrees", [-6, -3, 0, 3, 6])
def test_a_page_turned_a_few_degrees_still_has_its_rows(tilt_degrees: int) -> None:
    """Rows are measured on the page turned upright, so a tilted photograph keeps its columns and rows."""
    tilt = math.radians(tilt_degrees)
    rows = [
        row(0.34, ("Boxes", 0.07), ("1", 0.56), ("7.40", 0.67), ("7.40", 0.86), tilt=tilt),
        row(0.37, ("Tape", 0.07), ("1", 0.56), ("12.00", 0.66), ("12.00", 0.85), tilt=tilt),
    ]
    items = [
        {"description": "Boxes", "quantity": "1", "unit_price": "7.40", "total": "7.40"},
        {"description": "Tape", "quantity": "1", "unit_price": "12.00", "total": "12.00"},
    ]
    found = place_fields(invoice(line_items=items), [page(*rows)])
    second = [placed(found, f"line_items.1.{name}") for name in ("description", "quantity", "unit_price", "total")]
    first = [placed(found, f"line_items.0.{name}") for name in ("description", "quantity", "unit_price", "total")]
    assert all(later.quad[1] > earlier.quad[1] for earlier, later in zip(first, second, strict=True))
    assert first[3].quad[0] > first[2].quad[0] > first[1].quad[0] > first[0].quad[0]


def test_no_word_serves_two_fields() -> None:
    """Whatever the invoice holds, the words under two placements are never the same words."""
    reading = simple_invoice_page()
    found = place_fields(
        invoice(
            vendor="Bohemia Packaging s.r.o.",
            invoice_number="2026-0412",
            line_items=[
                {"description": "Kraft boxes", "quantity": "1", "unit_price": "7.40", "total": "7.40"},
                {"description": "Tape rolls", "quantity": "1", "unit_price": "12.00", "total": "12.00"},
            ],
            subtotal="19.40",
            vat=[{"rate": "21", "base": "19.40", "amount": "4.07"}],
            total="23.47",
        ),
        [reading],
    )
    corners = [placement.quad for placement in found.values()]
    assert len(corners) == len(set(corners))


def test_an_empty_page_and_an_empty_invoice_place_nothing() -> None:
    """Nothing to find and nothing to find it in are both fine."""
    assert place_fields(invoice(), [simple_invoice_page()]) == {}
    assert place_fields(invoice(total="1.00"), [PageWords(1, [])]) == {}
    assert place_fields(invoice(total="1.00"), []) == {}


def test_normalise_ignores_case_accents_and_punctuation() -> None:
    """Two spellings of a name compare equal after normalising."""
    assert normalise("Hanseatic  Green, Coffee GmbH.") == "hanseatic green coffee gmbh"
    assert normalise("Ceska čára") == "ceska cara"
    assert normalise("") == ""


def test_a_near_miss_number_differs_in_exactly_one_digit_of_the_same_length() -> None:
    """The near-miss test counts a single substituted digit and nothing more."""
    assert one_digit_substituted("104060", "104068")
    assert not one_digit_substituted("104060", "104060")
    assert not one_digit_substituted("104060", "104088")
    assert not one_digit_substituted("104060", "10460")
    assert not one_digit_substituted("10460", "104060")


def test_split_thousands_needs_groups_of_three() -> None:
    """Only a number written with a space as its thousands mark is joined from several words."""
    from lb03.boxes import Item

    def items(*texts: str) -> tuple[Item, ...]:
        """Make bare items from texts."""
        return tuple(Item(1, text, 0.9, (0.0,) * 8, 0.0, 0.0, 0.01, 0.01) for text in texts)

    assert is_split_thousands(items("1", "040,60"))
    assert is_split_thousands(items("12", "345", "678,90"))
    assert not is_split_thousands(items("2", "7.40"))
    assert not is_split_thousands(items("1234", "567"))


def test_dates_are_written_every_way_a_document_might() -> None:
    """The set of ways includes ISO, dots with and without zeros, slashes and month names."""
    forms = date_texts(date(2026, 4, 5))
    for expected in ("2026-04-05", "05.04.2026", "5.4.2026", "5. 4. 2026", "05/04/2026", "5 apr 2026", "april 5 2026"):
        assert expected in forms, expected


def test_amounts_use_decimal_so_no_float_rounding_decides_a_match() -> None:
    """A value that a float would round (0.1 + 0.2) is matched exactly as a decimal."""
    found = place_fields(invoice(total=str(Decimal("0.1") + Decimal("0.2"))), [page(row(0.1, ("0.30", 0.8)))])
    assert placed(found, "total").match == 1.0
