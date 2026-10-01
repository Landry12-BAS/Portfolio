"""Tests for LB-02's privacy rules: nothing real is read by a model, written to a transcript or kept in a booking."""

import pytest

from lb02.privacy import MaskedMessage, is_example_address, mask


@pytest.mark.parametrize(
    "address",
    [
        "jana@example.test",
        "Jana.Novak+demo@EXAMPLE.ORG",
        "a@example.com",
        "b@example.net",
        "c@mail.example.com",
        "d@shop.example",
        "e@broken.invalid",
        "f@my.localhost",
        "g@deep.sub.example.test",
    ],
)
def test_an_address_at_a_reserved_domain_is_an_example_address(address: str) -> None:
    """Only domains the standards reserve for examples can never reach a mailbox."""
    assert is_example_address(address)


@pytest.mark.parametrize(
    "address",
    [
        "tom@gmail.com",
        "tom@example.com.evil.com",
        "tom@notexample.com",
        "tom@evil.com/example.test",
        "tom@testing.org",
        "tom@mytest",
        "tom@example.testing.com",
        "tom@exampletest",
    ],
)
def test_every_other_address_is_a_real_one_or_could_be(address: str) -> None:
    """A lookalike, a longer domain that merely contains the word, and every ordinary domain are all refused."""
    assert not is_example_address(address)


def test_the_example_address_is_kept_and_replaced_by_a_label() -> None:
    """The service keeps the address for the booking; the model and the transcript see only [email]."""
    masked = mask("I'm Jana Novak, jana@example.test. Tomorrow at 2 pm please.")

    assert masked == MaskedMessage(
        text="I'm Jana Novak, [email]. Tomorrow at 2 pm please.",
        example_address="jana@example.test",
        real_addresses=0,
        numbers=0,
    )


def test_a_real_address_is_masked_counted_and_never_kept() -> None:
    """The visitor's gmail address never leaves this function."""
    masked = mask("Tom Baker, tom.baker@gmail.com")

    assert masked.text == "Tom Baker, [email]"
    assert masked.example_address is None
    assert masked.real_addresses == 1
    assert "gmail" not in masked.text


def test_only_the_first_example_address_is_kept_and_a_real_one_is_counted() -> None:
    """A second address is masked and ignored, so one booking has one contact; a real one is counted."""
    masked = mask("jana@example.test or jana@example.org or jana@gmail.com")

    assert masked.example_address == "jana@example.test"
    assert masked.real_addresses == 1
    assert masked.text == "[email] or [email] or [email]"


def test_a_malformed_example_address_isnt_kept() -> None:
    """An address the email field would refuse is counted as refused, not stored."""
    masked = mask("write to ..@example.test please")

    assert masked.example_address is None
    assert masked.text == "write to [email] please"


@pytest.mark.parametrize(
    "text",
    [
        "Call me on +420 777 123 456",
        "my number is 777123456 thanks",
        "card 4111 1111 1111 1111 expires soon",
        "IBAN CZ65 0800 0000 1920 0014 5399",
        "phone 777-123-456",
    ],
)
def test_phone_numbers_cards_and_bank_numbers_are_masked(text: str) -> None:
    """Nine digits or more in a row are masked, however they are grouped."""
    masked = mask(text)

    assert masked.numbers >= 1
    assert "[number]" in masked.text
    assert not any(run.isdigit() and len(run) >= 9 for run in masked.text.split())


@pytest.mark.parametrize(
    "text",
    [
        "tomorrow at 14:30",
        "2026-10-03 at 10:00",
        "3. 10. 2026",
        "booking K7QW-39XD",
        "for 12 people",
        "slot 12 please",
        "14.30",
    ],
)
def test_dates_times_and_small_numbers_are_left_alone(text: str) -> None:
    """The things a booking is about stay readable."""
    masked = mask(text)

    assert masked.text == text
    assert masked.numbers == 0


def test_a_hostile_message_cant_make_the_patterns_backtrack_out_of_control() -> None:
    """Long runs of the characters the patterns repeat are handled in a moment."""
    hostile = ("a." * 5_000) + "@" + ("b-" * 5_000) + " " + ("1 " * 5_000)

    masked = mask(hostile)

    assert isinstance(masked.text, str)
