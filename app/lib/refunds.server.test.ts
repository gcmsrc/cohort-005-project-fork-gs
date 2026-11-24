import { describe, it, expect } from "vitest";
import {
  checkRefundEligibility,
  MAX_WATCHED_SECONDS,
  type RefundFacts,
} from "./refunds.server";

function facts(overrides: Partial<RefundFacts> = {}): RefundFacts {
  return {
    purchasedAt: new Date(2026, 10, 1, 23, 0).toISOString(),
    today: new Date(2026, 10, 5, 12, 0),
    amountPaid: 7900,
    hasRefundRequest: false,
    hasClaimedSeat: false,
    completedLessons: 1,
    totalLessons: 10,
    secondsWatched: 600,
    ...overrides,
  };
}

describe("checkRefundEligibility", () => {
  it("offers a Refund of exactly the amount paid", () => {
    // A learner who paid $30 with a coupon on a $79 course gets $30 back,
    // never the list price.
    expect(checkRefundEligibility(facts({ amountPaid: 3000 }))).toEqual({
      eligible: true,
      amount: 3000,
      lastDayInWindow: "2026-11-15",
    });
  });

  it("allows only one Refund Request per Purchase, so a decline is final", () => {
    const result = checkRefundEligibility(facts({ hasRefundRequest: true }));
    expect(result).toMatchObject({ eligible: false, status: 409 });
  });

  it("refuses a claimed team seat", () => {
    const result = checkRefundEligibility(facts({ hasClaimedSeat: true }));
    expect(result).toMatchObject({ eligible: false, status: 403 });
  });

  it("counts the Refund Window in whole days, including the fourteenth", () => {
    const lastDay = checkRefundEligibility(
      facts({ today: new Date(2026, 10, 15, 23, 59) })
    );
    expect(lastDay.eligible).toBe(true);

    const dayAfter = checkRefundEligibility(
      facts({ today: new Date(2026, 10, 16, 0, 1) })
    );
    expect(dayAfter).toMatchObject({ eligible: false, status: 403 });
  });

  it("refuses once half the lessons are completed", () => {
    const result = checkRefundEligibility(
      facts({ completedLessons: 5, totalLessons: 10 })
    );
    expect(result).toMatchObject({ eligible: false, status: 403 });
  });

  it("refuses once the watch limit is reached", () => {
    const result = checkRefundEligibility(
      facts({ secondsWatched: MAX_WATCHED_SECONDS })
    );
    expect(result).toMatchObject({ eligible: false, status: 403 });
  });

  it("does not apply the completion rule to a course with no lessons", () => {
    const result = checkRefundEligibility(
      facts({ completedLessons: 0, totalLessons: 0 })
    );
    expect(result.eligible).toBe(true);
  });
});
