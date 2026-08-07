"use client";

import type { ReactNode } from "react";

/**
 * The block format the Spark website proposals are already written in, rendered
 * here so a proposal reads the same wherever it is opened.
 *
 * Four kinds, taken from the real documents rather than invented:
 *   prose  - heading + markdown body
 *   table  - heading + head row + rows, cells carry markdown
 *   links  - heading + optional body + labelled links with notes
 *   image  - src, alt, optional caption
 */
export type ProposalBlock =
  | { kind: "prose"; heading?: string; body?: string }
  | {
      kind: "table";
      heading?: string;
      table?: { head?: string[]; rows?: string[][] };
    }
  | {
      kind: "links";
      heading?: string;
      body?: string;
      links?: Array<{ href: string; label?: string; note?: string }>;
    }
  | {
      kind: "image";
      image?: { src?: string; alt?: string; caption?: string };
    };

/** **bold**, *italic* and [label](href), which is all these documents use. */
export function inline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={key} className="font-medium">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      return (
        <a
          key={key}
          href={link[2]}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

function Body({ text, idPrefix }: { text: string; idPrefix: string }) {
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-[#333]">
      {text.split("\n").map((line, i) => {
        const key = `${idPrefix}-${i}`;
        if (!line.trim()) return null;
        if (line.startsWith("### "))
          return (
            <h4 key={key} className="pt-3 text-[14px] font-medium">
              {inline(line.slice(4), key)}
            </h4>
          );
        if (line.startsWith("## "))
          return (
            <h3 key={key} className="pt-4 text-[16px] font-medium">
              {inline(line.slice(3), key)}
            </h3>
          );
        if (line.startsWith("- "))
          return (
            <li key={key} className="ml-5 list-disc">
              {inline(line.slice(2), key)}
            </li>
          );
        if (/^\d+\.\s/.test(line))
          return (
            <li key={key} className="ml-5 list-decimal">
              {inline(line.replace(/^\d+\.\s/, ""), key)}
            </li>
          );
        if (line.startsWith("> "))
          return (
            <blockquote
              key={key}
              className="border-l-2 border-border pl-4 text-[#606060]"
            >
              {inline(line.slice(2), key)}
            </blockquote>
          );
        return <p key={key}>{inline(line, key)}</p>;
      })}
    </div>
  );
}

export function ProposalBlocks({ blocks }: { blocks: ProposalBlock[] }) {
  return (
    <div className="space-y-8">
      {blocks.map((block, i) => {
        const key = `block-${i}`;
        const heading =
          "heading" in block && block.heading ? (
            <h2 className="mb-3 text-[18px] font-medium">{block.heading}</h2>
          ) : null;

        if (block.kind === "table") {
          const head = block.table?.head ?? [];
          const rows = block.table?.rows ?? [];
          return (
            <section key={key}>
              {heading}
              {/* Comparison tables are the widest thing in these documents, so
                  they scroll inside their own box rather than breaking the page. */}
              <div className="overflow-x-auto border border-border">
                <table className="w-full border-collapse text-[13px]">
                  {head.length > 0 && (
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        {head.map((h, hi) => (
                          <th
                            key={`${key}-h-${hi}`}
                            className="px-4 py-3 text-left font-medium"
                          >
                            {inline(h, `${key}-h-${hi}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {rows.map((row, ri) => (
                      <tr
                        key={`${key}-r-${ri}`}
                        className="border-b border-border last:border-b-0"
                      >
                        {row.map((cell, ci) => (
                          <td
                            key={`${key}-r-${ri}-c-${ci}`}
                            className="px-4 py-3 align-top text-[#333]"
                          >
                            {inline(cell, `${key}-r-${ri}-c-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        }

        if (block.kind === "links") {
          return (
            <section key={key}>
              {heading}
              {block.body ? <Body text={block.body} idPrefix={key} /> : null}
              <ul className="mt-3 space-y-2">
                {(block.links ?? []).map((l, li) => (
                  <li key={`${key}-l-${li}`} className="text-[14px]">
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      {l.label || l.href}
                    </a>
                    {l.note ? (
                      <span className="ml-2 text-[13px] text-[#606060]">
                        {l.note}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        }

        if (block.kind === "image") {
          const src = block.image?.src ?? "";
          // Relative sources belong to the website that authored them and would
          // 404 here, so the caption carries the meaning instead of a broken box.
          const absolute = /^https?:\/\//.test(src);
          return (
            <section key={key}>
              {absolute ? (
                // biome-ignore lint/performance/noImgElement: author-supplied, arbitrary host
                <img
                  src={src}
                  alt={block.image?.alt ?? ""}
                  className="w-full border border-border"
                />
              ) : null}
              {block.image?.caption ? (
                <p className="mt-2 text-[13px] text-[#606060]">
                  {block.image.caption}
                </p>
              ) : null}
            </section>
          );
        }

        return (
          <section key={key}>
            {heading}
            {block.body ? <Body text={block.body} idPrefix={key} /> : null}
          </section>
        );
      })}
    </div>
  );
}
