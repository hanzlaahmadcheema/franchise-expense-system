import { useEffect } from "react";

/**
 * useStickyTableHeaders
 *
 * Automatically keeps table headers (`thead`) sticky beneath the 56px AppHeader
 * when the page scrolls down, while allowing the table to expand naturally to show
 * ALL rows without inner vertical scrollbars or fixed max-heights.
 *
 * Works in tandem with horizontal scroll containers (`overflow-x: auto`) and
 * preserves sticky left columns (`left: 0`).
 */
export function useStickyTableHeaders(headerOffset = 56) {
  useEffect(() => {
    let ticking = false;

    function updateStickyHeaders() {
      const tables = document.querySelectorAll<HTMLTableElement>(
        "table.stock-entry-table, table.table-compact, table.sticky-header-table, .table-wrap table"
      );

      for (const table of tables) {
        const thead = table.querySelector("thead");
        if (!thead) continue;

        const tableRect = table.getBoundingClientRect();
        const theadHeight = thead.offsetHeight || 40;

        if (tableRect.top < headerOffset && tableRect.bottom > headerOffset + theadHeight) {
          const maxOffset = table.offsetHeight - theadHeight;
          const offset = Math.min(Math.max(0, headerOffset - tableRect.top), maxOffset);
          thead.style.transform = `translateY(${offset}px)`;
          thead.style.position = "relative";
          thead.style.zIndex = "25";
        } else {
          if (thead.style.transform && thead.style.transform !== "none") {
            thead.style.transform = "none";
          }
        }
      }
    }

    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          updateStickyHeaders();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    // Initial check
    updateStickyHeaders();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      const tables = document.querySelectorAll<HTMLTableElement>(
        "table.stock-entry-table, table.table-compact, table.sticky-header-table, .table-wrap table"
      );
      for (const table of tables) {
        const thead = table.querySelector("thead");
        if (thead && thead.style.transform !== "none") {
          thead.style.transform = "none";
        }
      }
    };
  }, [headerOffset]);
}
