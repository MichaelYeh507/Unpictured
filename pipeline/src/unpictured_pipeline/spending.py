"""Credit prices, the local cost log and the daily spending cap."""

import json
from datetime import date, datetime
from pathlib import Path

CREDITS_PER_USD = 1250

# Credits for one world from a regular (non-panorama) photo, from
# https://docs.worldlabs.ai/api/pricing (checked 2026-09-28). Plus uses its upper bound.
ESTIMATED_CREDITS_FROM_PHOTO = {
    "marble-1.0-draft": 230,
    "marble-1.0": 1580,
    "marble-1.1": 1580,
    "marble-1.1-plus": 3080,
}
# Two to four photos: the panorama step costs 100 credits instead of 80 (checked 2026-09-30).
ESTIMATED_CREDITS_FROM_PHOTOS = {
    "marble-1.0-draft": 250,
    "marble-1.0": 1600,
    "marble-1.1": 1600,
    "marble-1.1-plus": 3100,
}


class SpendingLimitError(Exception):
    pass


def credits_to_usd(credits: float) -> float:
    return credits / CREDITS_PER_USD


def estimate_credits(model: str, photo_count: int) -> int:
    if photo_count == 1:
        return ESTIMATED_CREDITS_FROM_PHOTO[model]
    return ESTIMATED_CREDITS_FROM_PHOTOS[model]


class CostLog:
    """Append-only JSON Lines log of every paid call.

    Events: "started" (estimated credits), "unconfirmed" (the start may or may not
    have been accepted; counted at its estimate) and "settled" (the billed credits).
    """

    def __init__(self, path: Path):
        self.path = path

    def record(self, event: str, operation_id: str, credits: float, **details) -> None:
        entry = {
            "time": datetime.now().astimezone().isoformat(timespec="seconds"),
            "event": event,
            "operation_id": operation_id,
            "credits": credits,
            **details,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(entry) + "\n")

    def credits_started_on(self, day: date) -> float:
        """Credits for calls started on `day`: the settled cost if known, else the estimate."""
        credits_by_operation: dict[str, float] = {}
        started_that_day: set[str] = set()
        for entry in self._entries():
            operation_id = entry["operation_id"]
            if entry["event"] in ("started", "unconfirmed"):
                credits_by_operation.setdefault(operation_id, entry["credits"])
                if datetime.fromisoformat(entry["time"]).date() == day:
                    started_that_day.add(operation_id)
            elif entry["event"] == "settled":
                credits_by_operation[operation_id] = entry["credits"]
        return sum(credits_by_operation[operation_id] for operation_id in started_that_day)

    def is_settled(self, operation_id: str) -> bool:
        return any(
            entry["event"] == "settled" and entry["operation_id"] == operation_id
            for entry in self._entries()
        )

    def _entries(self) -> list[dict]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]


def check_daily_cap(log: CostLog, estimated_credits: float, cap_usd: float, today: date) -> None:
    spent_usd = credits_to_usd(log.credits_started_on(today))
    total_usd = spent_usd + credits_to_usd(estimated_credits)
    if total_usd > cap_usd:
        raise SpendingLimitError(
            f"This call would bring today's spend to ${total_usd:.2f}, over the "
            f"${cap_usd:.2f} daily cap (UNPICTURED_DAILY_CAP_USD). Nothing was spent."
        )
