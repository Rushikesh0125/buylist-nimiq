import { useEffect, useId, useRef, useState } from "react";
import { api, usd, type Product } from "./api";

export default function ProductSearch({
  selected,
  onSelect,
}: {
  selected: Product | null;
  onSelect: (product: Product) => void;
}) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(-1);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const searchable = query.trim().length >= 2;
  const visible = open && searchable;
  const available = (p: Product) =>
    p.available && p.currency === "USD" && !!p.priceCents;

  useEffect(() => {
    setProducts([]);
    setActive(-1);
    setError("");
    if (!searchable) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void api<{ products: Product[] }>(
        "/api/products/search",
        "POST",
        { query: query.trim() },
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setProducts(result.products);
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(
              e instanceof Error
                ? e.message
                : "Search is unavailable. Please try again.",
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchable]);

  useEffect(() => {
    const panel = list.current;
    const option = panel?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    if (!panel || !option) return;
    const bounds = panel.getBoundingClientRect(),
      row = option.getBoundingClientRect();
    if (row.top < bounds.top) panel.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom)
      panel.scrollTop += row.bottom - bounds.bottom;
  }, [active]);

  const choose = (p: Product) => {
    onSelect(p);
    setOpen(false);
    setActive(-1);
  };
  return (
    <>
      <div
        className="product-search"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setOpen(false);
        }}
      >
        <label htmlFor={id}>Search products</label>
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? id + "-results" : undefined}
          aria-activedescendant={
            visible && active >= 0 ? id + "-option-" + active : undefined
          }
          autoComplete="off"
          maxLength={400}
          value={query}
          placeholder="What are you looking for?"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setActive(-1);
              return;
            }
            if (e.key === "Enter" && visible && active >= 0) {
              e.preventDefault();
              choose(products[active]);
              return;
            }
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            setOpen(true);
            const indices = products.flatMap((p, index) =>
              available(p) ? [index] : [],
            );
            if (!indices.length) return;
            const current = indices.indexOf(active);
            const next =
              current < 0
                ? e.key === "ArrowDown"
                  ? 0
                  : indices.length - 1
                : (current +
                    (e.key === "ArrowDown" ? 1 : -1) +
                    indices.length) %
                  indices.length;
            setActive(indices[next]);
          }}
        />
        {visible && (
          <div className="product-search-panel" ref={list}>
            {loading && <p role="status">Searching…</p>}
            {error && <p role="alert">{error}</p>}
            {!loading && !error && !products.length && (
              <p role="status">No products found. Try another search.</p>
            )}
            <div
              id={id + "-results"}
              role="listbox"
              aria-label="Products"
              aria-busy={loading}
            >
              {products.map((p, index) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  id={id + "-option-" + index}
                  data-index={index}
                  tabIndex={-1}
                  aria-selected={selected?.id === p.id}
                  disabled={!available(p)}
                  className={
                    "product-search-option" +
                    (active === index ? " active" : "")
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(p)}
                >
                  {p.imageUrl && <img src={p.imageUrl} alt="" />}
                  <span>
                    <strong>{p.title}</strong>
                    <small>
                      {available(p)
                        ? usd(p.priceCents!) +
                          (p.merchant ? " · " + p.merchant : "")
                        : "No available USD offer"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {selected && (
        <div className="selected-product">
          {selected.imageUrl && <img src={selected.imageUrl} alt="" />}
          <span>
            <small>Selected product</small>
            <strong>{selected.title}</strong>
          </span>
        </div>
      )}
    </>
  );
}
