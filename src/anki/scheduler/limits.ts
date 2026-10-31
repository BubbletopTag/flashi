// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of rslib/src/decks/limits.rs (Copyright: Ankitects Pty Ltd and contributors), v3 only.

import type { Deck, DeckConfig } from "../config";

export type LimitKind = "review" | "new";

export interface RemainingLimits {
  review: number;
  new: number;
  capNewToReview: boolean;
}

function limitIfToday(limit: { limit: number; today: number } | null, today: number): number | null {
  return limit && limit.today === today ? limit.limit : null;
}

export function remainingLimits(
  deck: Deck,
  config: DeckConfig | undefined,
  today: number,
  newCardsIgnoreReviewLimit: boolean,
): RemainingLimits {
  if (deck.filtered || !config) return { review: 9999, new: 9999, capNewToReview: false };
  let review = limitIfToday(deck.reviewLimitToday, today) ?? deck.reviewLimit ?? config.reviewsPerDay;
  let fresh = limitIfToday(deck.newLimitToday, today) ?? deck.newLimit ?? config.newPerDay;
  const [newToday, reviewToday] =
    deck.lastDayStudied === today ? [deck.newStudied, deck.reviewStudied] : [0, 0];
  review -= reviewToday;
  fresh -= newToday;
  if (!newCardsIgnoreReviewLimit) {
    review -= newToday;
    fresh = Math.min(fresh, review);
  }
  return { review: Math.max(review, 0), new: Math.max(fresh, 0), capNewToReview: !newCardsIgnoreReviewLimit };
}

export function capTo(limits: RemainingLimits, cap: RemainingLimits): void {
  limits.review = Math.min(limits.review, cap.review);
  limits.new = Math.min(limits.new, cap.new);
}

interface Node {
  level: number;
  limits: RemainingLimits;
  parent: Node | null;
  children: Node[];
}

function levelOf(name: string): number {
  return name.split("::").length;
}

/** Limits for a deck and its descendants, as used while building a study queue. */
export class LimitTreeMap {
  private readonly map = new Map<number, Node>();
  private readonly root: Node;

  /** `decks` must start with the root deck, followed by its descendants in name order. */
  constructor(
    decks: readonly Deck[],
    configs: ReadonlyMap<number, DeckConfig>,
    today: number,
    newCardsIgnoreReviewLimit: boolean,
  ) {
    const make = (deck: Deck, parent: Node | null): Node => {
      const limits = remainingLimits(deck, configs.get(deck.configId), today, newCardsIgnoreReviewLimit);
      if (parent) capTo(limits, parent.limits);
      const node: Node = { level: levelOf(deck.name), limits, parent, children: [] };
      parent?.children.push(node);
      this.map.set(deck.id, node);
      return node;
    };
    this.root = make(decks[0]!, null);
    let i = 1;
    const addChildren = (parent: Node) => {
      while (i < decks.length) {
        const deck = decks[i]!;
        const level = levelOf(deck.name);
        if (level <= parent.level) return;
        if (level === parent.level + 1) {
          make(deck, parent);
          i++;
        } else {
          const last = parent.children[parent.children.length - 1];
          if (last) addChildren(last);
          else i++;
        }
      }
    };
    addChildren(this.root);
  }

  rootLimitReached(kind: LimitKind): boolean {
    return this.root.limits[kind] === 0;
  }

  limitReached(deckId: number, kind: LimitKind): boolean {
    const node = this.map.get(deckId);
    if (!node) throw new Error("deck not found in limits map");
    return node.limits[kind] === 0;
  }

  decrementDeckAndParentLimits(deckId: number, kind: LimitKind): void {
    let node: Node | null | undefined = this.map.get(deckId);
    while (node) {
      const before = { ...node.limits };
      const l = node.limits;
      if (kind === "review") {
        l.review = Math.max(l.review - 1, 0);
        if (l.capNewToReview) l.new = Math.min(l.new, l.review);
      } else {
        l.new = Math.max(l.new - 1, 0);
      }
      const reachedZero = (before.review > 0 && l.review === 0) || (before.new > 0 && l.new === 0);
      if (reachedZero) capNodeAndDescendants(node, { ...l });
      node = node.parent;
    }
  }
}

function capNodeAndDescendants(node: Node, limits: RemainingLimits): void {
  capTo(node.limits, limits);
  for (const child of node.children) capNodeAndDescendants(child, limits);
}
