// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of the deck-list counts in rslib/src/decks/tree.rs
// (Copyright: Ankitects Pty Ltd and contributors), v3 only.

import type { Deck, DeckConfig } from "../config";
import { capTo, remainingLimits, type RemainingLimits } from "./limits";

export interface DueCounts {
  new: number;
  review: number;
  interdayLearning: number;
  intradayLearning: number;
  total: number;
}

export interface DeckTreeNode {
  deckId: number;
  /** Last component of the deck name. */
  name: string;
  fullName: string;
  level: number;
  collapsed: boolean;
  filtered: boolean;
  newCount: number;
  reviewCount: number;
  learnCount: number;
  totalInDeck: number;
  totalIncludingChildren: number;
  children: DeckTreeNode[];
}

interface NodeCounts {
  new: number;
  review: number;
  intradayLearning: number;
  interdayLearning: number;
  total: number;
}

function capped(c: NodeCounts, remaining: RemainingLimits): NodeCounts {
  const out = { ...c };
  out.interdayLearning = Math.min(out.interdayLearning, remaining.review);
  let remainingReviews = Math.max(remaining.review - out.interdayLearning, 0);
  out.review = Math.min(out.review, remainingReviews);
  out.new = Math.min(out.new, remaining.new);
  if (remaining.capNewToReview) {
    remainingReviews = Math.max(remainingReviews - out.review, 0);
    out.new = Math.min(out.new, remainingReviews);
  }
  return out;
}

/** Build the (root-less) deck tree from decks sorted by name. */
function namesToTree(decks: readonly Deck[]): DeckTreeNode {
  const top: DeckTreeNode = {
    deckId: 0, name: "", fullName: "", level: 0, collapsed: false, filtered: false,
    newCount: 0, reviewCount: 0, learnCount: 0, totalInDeck: 0, totalIncludingChildren: 0, children: [],
  };
  let i = 0;
  const addChildren = (parent: DeckTreeNode) => {
    while (i < decks.length) {
      const deck = decks[i]!;
      const parts = deck.name.split("::");
      const level = Math.min(parts.length, 99);
      if (level <= parent.level) return;
      if (level === parent.level + 1) {
        parent.children.push({
          deckId: deck.id,
          name: parts[parts.length - 1]!,
          fullName: deck.name,
          level,
          collapsed: deck.collapsed,
          filtered: deck.filtered,
          newCount: 0, reviewCount: 0, learnCount: 0, totalInDeck: 0, totalIncludingChildren: 0,
          children: [],
        });
        i++;
      } else {
        const last = parent.children[parent.children.length - 1];
        if (last) addChildren(last);
        else i++;
      }
    }
  };
  addChildren(top);
  return top;
}

export function buildDeckTree(
  decksSorted: readonly Deck[],
  configs: ReadonlyMap<number, DeckConfig>,
  counts: ReadonlyMap<number, DueCounts>,
  today: number,
  options: { newCardsIgnoreReviewLimit: boolean; applyAllParentLimits: boolean; defaultDeckIsEmpty: boolean },
): DeckTreeNode {
  const tree = namesToTree(decksSorted);
  if (options.defaultDeckIsEmpty) hideDefaultDeck(tree);
  const limits = new Map<number, RemainingLimits>();
  for (const deck of decksSorted) {
    limits.set(deck.id, remainingLimits(deck, configs.get(deck.configId), today, options.newCardsIgnoreReviewLimit));
  }
  const sum = (node: DeckTreeNode, parentLimits: RemainingLimits | null): NodeCounts => {
    const remaining = { ...(limits.get(node.deckId) ?? { review: 9999, new: 9999, capNewToReview: false }) };
    let childParent = parentLimits;
    if (parentLimits) {
      capTo(remaining, parentLimits);
      childParent = remaining;
    }
    const own = counts.get(node.deckId);
    const uncapped: NodeCounts = {
      new: own?.new ?? 0,
      review: own?.review ?? 0,
      intradayLearning: own?.intradayLearning ?? 0,
      interdayLearning: own?.interdayLearning ?? 0,
      total: own?.total ?? 0,
    };
    node.totalInDeck = uncapped.total;
    let totalWithChildren = node.totalInDeck;
    for (const child of node.children) {
      const c = sum(child, childParent);
      uncapped.new += c.new;
      uncapped.review += c.review;
      uncapped.intradayLearning += c.intradayLearning;
      uncapped.interdayLearning += c.interdayLearning;
      uncapped.total += c.total;
      totalWithChildren += child.totalIncludingChildren;
    }
    const c = capped(uncapped, remaining);
    node.newCount = c.new;
    node.reviewCount = c.review;
    node.learnCount = c.intradayLearning + c.interdayLearning;
    node.totalIncludingChildren = totalWithChildren;
    return c;
  };
  const rootParent = options.applyAllParentLimits ? { review: 9999, new: 9999, capNewToReview: false } : null;
  for (const child of tree.children) sum(child, rootParent);
  return tree;
}

function hideDefaultDeck(node: DeckTreeNode): void {
  const idx = node.children.findIndex((c) => c.deckId === 1 && c.children.length === 0);
  if (idx < 0) return;
  const child = node.children[idx]!;
  if (child.level === 1 && node.children.length === 1) return;
  node.children.splice(idx, 1);
}

export function findNode(tree: DeckTreeNode, deckId: number): DeckTreeNode | null {
  if (tree.deckId === deckId) return tree;
  for (const child of tree.children) {
    const found = findNode(child, deckId);
    if (found) return found;
  }
  return null;
}
