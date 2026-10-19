"""Filing excerpts for supply-chain relationships: matching, figures and no-churn updates."""

from app.services.relationship_notes import FilingNote, figures_in, find_mentions, fingerprint, reconcile

TEXT = (
    "We believe aggregate sales to Apple Inc., through all channels, accounted for approximately 20% of our net revenue for fiscal 2023. "
    "Ms. Smith held a variety of positions at Apple, including Chief Financial Officer of a division. "
    "Key competitors include Apple, Google and Microsoft, a number of which also offer cloud services. "
    "Pineapple growers are not mentioned in this filing as customers of anyone at all. "
    "We entered into a multi-year supply agreement with Apple for custom RF modules worth $2.5 billion."
)


def test_matches_relationship_sentences_only():
    hits = find_mentions(TEXT, ["Apple"])
    assert len(hits) == 2
    assert hits[0].startswith("We believe aggregate sales") and hits[1].startswith("We entered into")
    assert figures_in(hits) == ["20%", "$2.5 billion"]


def _note(excerpts, accession="A1"):
    return FilingNote("AVGO", "10-K", accession, "2025-01-01", "https://www.sec.gov/x", excerpts, figures_in(excerpts), fingerprint(excerpts), "2025-01-02", None, accession)


def test_unchanged_filing_leaves_the_note_untouched():
    stored = _note(["Same sentence about Apple revenue."])
    filing = {"form": "10-K", "accession": "A2", "filed": "2026-01-01", "url": "https://www.sec.gov/y"}
    note, changed = reconcile(stored, filing, ["Same sentence about Apple revenue."], "2026-01-02")
    assert not changed
    assert (note.accession, note.as_of, note.excerpts) == ("A1", "2025-01-02", stored.excerpts)  # content and date kept
    assert note.checked_accession == "A2"  # but the new filing is recorded as read


def test_new_disclosure_replaces_the_note_and_records_what_it_superseded():
    stored = _note(["Old sentence about Apple revenue."])
    filing = {"form": "10-K", "accession": "A2", "filed": "2026-01-01", "url": "https://www.sec.gov/y"}
    note, changed = reconcile(stored, filing, ["New: Apple accounted for 25% of revenue."], "2026-01-02")
    assert changed and note.accession == "A2" and note.updated_from == "A1" and note.figures == ["25%"]


def test_quote_from_an_older_report_is_flagged():
    older = {"form": "10-K", "accession": "A0", "filed": "2023-12-14", "url": "https://www.sec.gov/z"}
    note, _ = reconcile(None, older, ["Apple accounted for 20% of revenue."], "2026-01-02", latest="A2")
    assert note.accession == "A0" and note.checked_accession == "A2" and not note.latest_names_partner


def test_restated_disclosures_are_quoted_once():
    text = (
        "For fiscal 2026 we had one end customer, Apple Inc., who represented approximately 91 percent of net sales. "
        "For the twelve months ended March 2026 our end customer Apple Inc. represented approximately 91 percent of total net sales."
    )
    assert len(find_mentions(text, ["Apple"])) == 1


def test_company_abbreviations_do_not_end_sentences():
    text = 'We entered into an agreement under which Meta Platforms, Inc. ("Meta") committed to pay us up to $14.2 billion for cloud capacity.'
    assert find_mentions(text, ["Meta Platforms"]) == [text]
