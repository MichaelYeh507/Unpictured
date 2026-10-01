import json
from datetime import date

import pytest

from unpictured_pipeline.spending import (
    ESTIMATED_CREDITS_FROM_PHOTO,
    ESTIMATED_CREDITS_FROM_PHOTOS,
    CostLog,
    SpendingLimitError,
    check_daily_cap,
)


def test_every_model_has_a_price_for_one_photo_and_for_several():
    # --model choices come from the one-photo table, so the other must cover them too.
    assert ESTIMATED_CREDITS_FROM_PHOTOS.keys() == ESTIMATED_CREDITS_FROM_PHOTO.keys()


def test_spend_prefers_settled_cost_and_counts_only_that_day(tmp_path):
    path = tmp_path / "cost_log.jsonl"
    entries = [
        {
            "time": "2026-09-28T10:00:00-04:00",
            "event": "started",
            "operation_id": "a",
            "credits": 230,
        },
        {
            "time": "2026-09-28T10:01:00-04:00",
            "event": "settled",
            "operation_id": "a",
            "credits": 150,
        },
        {
            "time": "2026-09-28T11:00:00-04:00",
            "event": "unconfirmed",
            "operation_id": "b",
            "credits": 1580,
        },
        {
            "time": "2026-09-27T23:00:00-04:00",
            "event": "started",
            "operation_id": "c",
            "credits": 1580,
        },
    ]
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")

    assert CostLog(path).credits_started_on(date(2026, 9, 28)) == 150 + 1580


def test_cap_allows_spending_up_to_the_limit_and_refuses_beyond_it(tmp_path):
    empty_log = CostLog(tmp_path / "cost_log.jsonl")
    today = date(2026, 9, 28)

    check_daily_cap(empty_log, 1250, cap_usd=1.0, today=today)  # exactly $1.00
    with pytest.raises(SpendingLimitError):
        check_daily_cap(empty_log, 1251, cap_usd=1.0, today=today)
