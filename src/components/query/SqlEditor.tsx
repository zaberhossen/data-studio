"use client";

/**
 * SqlEditor — a CodeMirror 6 SQL editor with schema-driven autocomplete.
 *
 * Same external contract as the textarea stand-in it replaces: `QueryPanel`
 * talks to it via `value`/`onChange`/`readOnly`/`schema`/`tableName` only.
 * Autocomplete (keywords + table + `column: dataType`) comes from
 * `@codemirror/lang-sql`'s schema option, fed by the active source's `Field[]`
 * — no separate completion source to keep in sync.
 *
 * shadcn/tokens: the editor theme reads the same HSL CSS variables as the rest
 * of the app (`--card`, `--foreground`, `--primary`, …) so it follows
 * light/dark automatically without reconfiguring on theme toggle.
 */

import * as React from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import type { Field } from "@/lib/query/schema";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  /** Active source schema — drives the SQL language's column completions. */
  schema?: Field[];
  /** Table name the dataset is registered under (defaults to `dataset`). */
  tableName?: string;
  "aria-label"?: string;
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "0.8125rem",
    color: "hsl(var(--foreground))",
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--input))",
    borderRadius: "calc(var(--radius) - 2px)",
  },
  "&.cm-focused": {
    outline: "none",
    borderColor: "hsl(var(--ring))",
    boxShadow: "0 0 0 1px hsl(var(--ring))",
  },
  ".cm-content": {
    fontFamily:
      "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    caretColor: "hsl(var(--foreground))",
    padding: "0.5rem 0",
  },
  ".cm-scroller": { overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "hsl(var(--card))",
    color: "hsl(var(--muted-foreground))",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "hsl(var(--muted) / 0.5)" },
  ".cm-activeLineGutter": { backgroundColor: "hsl(var(--muted) / 0.5)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "hsl(var(--primary) / 0.2) !important",
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "hsl(var(--accent))",
    outline: "1px solid hsl(var(--border))",
  },
  ".cm-placeholder": { color: "hsl(var(--muted-foreground))" },
  ".cm-tooltip": {
    backgroundColor: "hsl(var(--popover))",
    color: "hsl(var(--popover-foreground))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "calc(var(--radius) - 2px)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontSize: "0.8125rem" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "hsl(var(--accent))",
    color: "hsl(var(--accent-foreground))",
  },
  ".cm-completionDetail": {
    color: "hsl(var(--muted-foreground))",
    fontStyle: "normal",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "hsl(var(--primary))", fontWeight: "600" },
  { tag: [tags.name, tags.propertyName], color: "hsl(var(--foreground))" },
  { tag: [tags.string, tags.special(tags.string)], color: "hsl(var(--code-string))" },
  { tag: tags.number, color: "hsl(var(--code-number))" },
  { tag: tags.comment, color: "hsl(var(--muted-foreground))", fontStyle: "italic" },
  { tag: tags.operator, color: "hsl(var(--muted-foreground))" },
  { tag: tags.paren, color: "hsl(var(--muted-foreground))" },
]);

/** SQL column completions with dataType shown as the completion's detail. */
function schemaCompletions(schema: Field[]): Completion[] {
  return schema.map((f) => ({
    label: f.name,
    type: "property",
    detail: f.dataType,
  }));
}

export function SqlEditor({
  value,
  onChange,
  placeholder = "SELECT … FROM dataset GROUP BY …",
  readOnly = false,
  schema = [],
  tableName = "dataset",
  "aria-label": ariaLabel = "SQL editor",
}: SqlEditorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  // eslint-disable-next-line react-hooks/refs -- keep a ref to the latest onChange so the once-created editor's change handler always calls the current callback without re-creating the editor
  onChangeRef.current = onChange;

  const [readOnlyCompartment] = React.useState(() => new Compartment());
  const [sqlCompartment] = React.useState(() => new Compartment());

  // Create the editor once.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = new EditorView({
      doc: value,
      parent: container,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentOnInput(),
        closeBrackets(),
        bracketMatching(),
        syntaxHighlighting(highlightStyle),
        sqlCompartment.of(
          sql({
            dialect: StandardSQL,
            schema: { [tableName]: schemaCompletions(schema) },
            defaultTable: tableName,
            upperCaseKeywords: true,
          }),
        ),
        autocompletion(),
        placeholderExt(placeholder),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        theme,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });
    view.contentDOM.setAttribute("aria-label", ariaLabel);
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; schema/tableName/readOnly updates are pushed via
    // the compartments below, and `value` sync is handled in its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external `value` changes (e.g. Builder→SQL translation) into the doc
  // without disturbing the user's cursor when the change originated here.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // Push readOnly changes without recreating the editor.
  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, readOnlyCompartment]);

  // Push schema/table changes (new active source) without recreating the editor.
  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: sqlCompartment.reconfigure(
        sql({
          dialect: StandardSQL,
          schema: { [tableName]: schemaCompletions(schema) },
          defaultTable: tableName,
          upperCaseKeywords: true,
        }),
      ),
    });
    // schema is a derived array (new identity per render); compare by content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, JSON.stringify(schema), sqlCompartment]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      {schema.length > 0 && (
        <p className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {tableName} · {schema.length} columns · Ctrl+Space for completions
        </p>
      )}
    </div>
  );
}
