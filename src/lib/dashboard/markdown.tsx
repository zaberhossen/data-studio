/**
 * A tiny, dependency-free Markdown renderer for canvas text cards.
 *
 * Supports a deliberately SMALL, safe subset — headings (#/##/###), unordered
 * (-,*) and ordered (1.) lists, paragraphs, and inline **bold**, *italic*,
 * `code`, and [links](url). It returns React nodes (never raw HTML), so text is
 * auto-escaped and there's no injection surface; link hrefs are scheme-checked
 * (http/https/mailto/relative only) so `javascript:` URIs render as plain text.
 */

import * as React from "react";

/** Allow only safe link schemes; anything else renders as its literal text. */
function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^\/(?!\/)/.test(u)) return u; // site-relative ("/x"), not protocol-relative ("//x")
  return null;
}

/** Parse inline spans: **bold**, *italic*, `code`, [text](url). */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[2] !== undefined) {
      out.push(<strong key={key}>{m[2]}</strong>);
    } else if (m[4] !== undefined) {
      out.push(<em key={key}>{m[4]}</em>);
    } else if (m[6] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {m[6]}
        </code>,
      );
    } else if (m[8] !== undefined) {
      const href = safeHref(m[9]);
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {m[8]}
          </a>
        ) : (
          m[0]
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-2xl font-semibold",
  2: "text-xl font-semibold",
  3: "text-lg font-semibold",
};

/** Render a Markdown string to React nodes (block-level, then inline). */
export function renderMarkdown(src: string): React.ReactNode {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={`p-${key++}`} className="my-1">
        {renderInline(para.join(" "), `p${key}`)}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{renderInline(it, `li${key}-${i}`)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={`ol-${key++}`} className="my-1 list-decimal pl-5">{items}</ol>
      ) : (
        <ul key={`ul-${key++}`} className="my-1 list-disc pl-5">{items}</ul>
      ),
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);

    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const Tag = (`h${level}` as "h1" | "h2" | "h3");
      blocks.push(
        <Tag key={`h-${key++}`} className={HEADING_CLASS[level]}>
          {renderInline(heading[2], `h${key}`)}
        </Tag>,
      );
      continue;
    }
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    // plain paragraph line
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return <>{blocks}</>;
}
