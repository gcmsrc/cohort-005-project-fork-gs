import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCHED_SECONDS = 2 * 60 * 60;
export const MAX_COMPLETED_SHARE = 0.5;

type Purchase = typeof purchases.$inferSelect;

export type RefundFacts = {
  purchasedAt: string;
  today: Date;
  amountPaid: number;
  hasRefundRequest: boolean;
  hasClaimedSeat: boolean;
  completedLessons: number;
  totalLessons: number;
  secondsWatched: number;
};

export type RefundEligibility =
  | { eligible: true; amount: number; lastDayInWindow: string }
  | { eligible: false; reason: string; status: 403 | 409 };

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 should still get the whole of their fourteenth day.
export function asDayString(when: Date): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whether a learner may raise a Refund Request on a Purchase, and if so what
 * the Refund would be. The single source of these rules: the course page
 * offer and the refund action both ask this.
 */
export function checkRefundEligibility(facts: RefundFacts): RefundEligibility {
  // A Purchase has at most one Refund Request — a declined one is final.
  if (facts.hasRefundRequest) {
    return {
      eligible: false,
      reason: "You have already raised a Refund Request on this purchase.",
      status: 409,
    };
  }

  // A claimed team seat belongs to the team buyer, not to the learner.
  if (facts.hasClaimedSeat) {
    return {
      eligible: false,
      reason: "A claimed team seat cannot be refunded.",
      status: 403,
    };
  }

  const purchasedDay = asDayString(new Date(facts.purchasedAt));
  const windowEnd = new Date(facts.purchasedAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = asDayString(windowEnd);
  const today = asDayString(facts.today);

  if (today < purchasedDay || today > lastDayInWindow) {
    return {
      eligible: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day Refund Window has closed.`,
      status: 403,
    };
  }

  if (
    facts.totalLessons > 0 &&
    facts.completedLessons / facts.totalLessons >= MAX_COMPLETED_SHARE
  ) {
    return {
      eligible: false,
      reason: "You have completed too much of this course to get a refund.",
      status: 403,
    };
  }

  if (facts.secondsWatched >= MAX_WATCHED_SECONDS) {
    return {
      eligible: false,
      reason: "You have watched too much of this course to get a refund.",
      status: 403,
    };
  }

  // A Refund is always exactly what was paid — never the course's list price.
  return { eligible: true, amount: facts.amountPaid, lastDayInWindow };
}

export function getLatestPurchase(
  userId: number,
  courseId: number
): Purchase | undefined {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasRefundRequest(purchaseId: number) {
  return Boolean(
    db
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.purchaseId, purchaseId))
      .get()
  );
}

function hasClaimedSeat(purchaseId: number) {
  return Boolean(
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
      )
      .get()
  );
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

/**
 * Looks up the learner's latest Purchase of a course and checks it against
 * the refund rules. Returns null when the learner has not bought the course.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  today: Date = new Date()
): { purchase: Purchase; eligibility: RefundEligibility } | null {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return null;

  const lessonIds = getLessonIdsForCourse(courseId);

  const eligibility = checkRefundEligibility({
    purchasedAt: purchase.createdAt,
    today,
    amountPaid: purchase.amountPaid,
    hasRefundRequest: hasRefundRequest(purchase.id),
    hasClaimedSeat: hasClaimedSeat(purchase.id),
    completedLessons: getCompletedLessonCount(userId, lessonIds),
    totalLessons: lessonIds.length,
    secondsWatched: getSecondsWatched(userId, lessonIds),
  });

  return { purchase, eligibility };
}
