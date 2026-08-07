"use client";

/**
 * Minimal markdown for proposal bodies: headings, bold, lists, paragraphs.
 *
 * The body is written by us (Claude Code), not submitted by a client, so this
 * renders rather than sanitises arbitrary input, and deliberately supports no
 * raw HTML. Shared by the client-facing proposal page and the portal list so the
 * document reads identically wherever it is opened.
 */
export function ProposalMarkdown({ source }: { source: string }) {
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-[#333]">
      {source.split("\n").map((line, i) => {
        const key = `${i}-${line.slice(0, 12)}`;
        const bold = (t: string) =>
          t.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith("**") && part.endsWith("**") ? (
              <strong key={`${key}-${j}`} className="font-medium">
                {part.slice(2, -2)}
              </strong>
            ) : (
              part
            ),
          );
        if (line.startsWith("### "))
          return (
            <h4 key={key} className="pt-3 text-[14px] font-medium">
              {line.slice(4)}
            </h4>
          );
        if (line.startsWith("## "))
          return (
            <h3 key={key} className="pt-4 text-[16px] font-medium">
              {line.slice(3)}
            </h3>
          );
        if (line.startsWith("# "))
          return (
            <h2 key={key} className="pt-3 text-[18px] font-medium">
              {line.slice(2)}
            </h2>
          );
        if (line.startsWith("- "))
          return (
            <li key={key} className="ml-5 list-disc">
              {bold(line.slice(2))}
            </li>
          );
        if (line.startsWith("> "))
          return (
            <blockquote
              key={key}
              className="border-l-2 border-border pl-4 text-[#606060]"
            >
              {bold(line.slice(2))}
            </blockquote>
          );
        if (!line.trim()) return null;
        return <p key={key}>{bold(line)}</p>;
      })}
    </div>
  );
}
