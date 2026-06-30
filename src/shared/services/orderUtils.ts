export type OrderedItem = {
  id: string;
  sortOrder?: number | null;
  displayOrder?: number | null;
  createdAt?: number | null;
  name?: string | null;
  line?: string | null;
};

function orderValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function orderedBySortOrder<T extends OrderedItem>(items: T[]) {
  return [...items].sort((left, right) => {
    const leftSort = orderValue(left.sortOrder);
    const rightSort = orderValue(right.sortOrder);
    if (leftSort != null && rightSort != null && leftSort !== rightSort) return leftSort - rightSort;
    if (leftSort != null && rightSort == null) return -1;
    if (leftSort == null && rightSort != null) return 1;

    const leftLegacy = orderValue(left.displayOrder);
    const rightLegacy = orderValue(right.displayOrder);
    if (leftLegacy != null && rightLegacy != null && leftLegacy !== rightLegacy) return leftLegacy - rightLegacy;
    if (leftLegacy != null && rightLegacy == null) return -1;
    if (leftLegacy == null && rightLegacy != null) return 1;

    const leftCreated = orderValue(left.createdAt);
    const rightCreated = orderValue(right.createdAt);
    if (leftCreated != null && rightCreated != null && leftCreated !== rightCreated) return leftCreated - rightCreated;

    const leftLabel = String(left.name ?? left.line ?? left.id);
    const rightLabel = String(right.name ?? right.line ?? right.id);
    return leftLabel.localeCompare(rightLabel);
  });
}

export function reorderItems<T extends { id: string }>(items: T[], activeId: string, overId: string) {
  if (activeId === overId) return items;
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const overIndex = items.findIndex((item) => item.id === overId);
  if (activeIndex < 0 || overIndex < 0) return items;
  const next = [...items];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next;
}

export function applySortOrder<T extends OrderedItem>(items: T[]) {
  return items.map((item, index) => ({ ...item, sortOrder: index + 1 }));
}

export function changedSortOrderPatches<T extends OrderedItem>(before: T[], after: T[]) {
  const previous = new Map(before.map((item) => [item.id, orderValue(item.sortOrder)]));
  return after
    .map((item, index) => ({ id: item.id, sortOrder: index + 1 }))
    .filter((item) => previous.get(item.id) !== item.sortOrder);
}
