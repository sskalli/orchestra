import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import type { Components, UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent } from "hast";
import { CopyButton } from "./copy-button.tsx";
import { chatImageSource, isWebLink } from "./workspace-markdown-links.ts";

import "./workspace-markdown.css";

type MarkdownContextValue = { agentId?: string; streaming: boolean };
const MarkdownContext = createContext<MarkdownContextValue>({ streaming: false });
/** Set inside a web link, where nested buttons and links would be invalid. */
const InsideLink = createContext(false);

function textOf(node: Element | ElementContent | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map((child) => textOf(child as ElementContent)).join("") : "";
}

function contains(node: Element | ElementContent | undefined, tagName: string): boolean {
  return !!node && node.type === "element" && (node.tagName === tagName || node.children.some((child) => contains(child, tagName)));
}

const shortLabel = (text: string) => text.length > 40 ? `${text.slice(0, 39)}…` : text;

function InlineCode({ text, title }: { text: string; title?: string }) {
  const insideLink = useContext(InsideLink);
  if (insideLink || !text.trim()) return <code title={title}>{text}</code>;
  return (
    <span className="chat-code-inline">
      <code title={title}>{text}</code>
      <CopyButton text={text} label={`Copy \`${shortLabel(text)}\``} className="chat-code-copy" />
    </span>
  );
}

function CodeBlock({ language, source, children, footer }: { language?: string; source: string; children?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span className="chat-code-language">{language}</span>
        <CopyButton text={source} label={language === "mermaid" ? "Copy diagram source" : "Copy code"} />
      </div>
      {children ?? <pre><code className={language ? `language-${language}` : undefined}>{source}</code></pre>}
      {footer}
    </div>
  );
}

type MermaidApi = typeof import("mermaid").default;
let mermaidLoader: Promise<MermaidApi> | undefined;
let diagramCount = 0;

function loadMermaid() {
  mermaidLoader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "inherit",
      themeVariables: { background: "transparent" },
    });
    return mermaid;
  }).catch((error) => {
    mermaidLoader = undefined;
    throw error;
  });
  return mermaidLoader;
}

function MermaidBlock({ source }: { source: string }) {
  const { streaming } = useContext(MarkdownContext);
  const [result, setResult] = useState<{ source: string; svg?: string; failed?: true }>();
  useEffect(() => {
    // A streaming message shows the code until it completes, so partial diagrams never flash parse errors.
    if (streaming) return;
    let cancelled = false;
    const id = `chat-mermaid-${++diagramCount}`;
    void loadMermaid().then(async (mermaid) => {
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      if (!cancelled) setResult({ source, svg });
    }).catch(() => {
      // Mermaid can leave its scratch container behind when rendering fails.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (!cancelled) setResult({ source, failed: true });
    });
    return () => {
      cancelled = true;
    };
  }, [source, streaming]);

  const current = result?.source === source && !streaming ? result : undefined;
  if (current?.svg) {
    return (
      <CodeBlock language="mermaid" source={source}>
        <div className="chat-mermaid-diagram" role="img" aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: current.svg }} />
      </CodeBlock>
    );
  }
  return <CodeBlock language="mermaid" source={source}
    footer={current?.failed ? <p className="chat-mermaid-error" role="note">Diagram could not be rendered.</p> : undefined} />;
}

function ChatImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const { agentId } = useContext(MarkdownContext);
  const insideLink = useContext(InsideLink);
  const source = chatImageSource(src ?? "", agentId);
  const [failed, setFailed] = useState<string>();
  if (!source || failed === source) {
    return (
      <span className="chat-image-blocked" role="note">
        <span>Image not shown</span>
        {src ? <code>{src}</code> : alt ? <code>{alt}</code> : null}
      </span>
    );
  }
  const image = <img className="chat-image" src={source} alt={alt ?? ""} title={title} loading="lazy" decoding="async"
    referrerPolicy="no-referrer" onError={() => setFailed(source)} />;
  if (insideLink) return image;
  return <a className="chat-image-link" href={source} target="_blank" rel="noopener noreferrer"
    aria-label={alt ? `Open image: ${alt}` : "Open image in a new tab"}>{image}</a>;
}

const components: Components = {
  a: ({ href, children, node }) => {
    if (href && isWebLink(href)) {
      return <InsideLink.Provider value>
        <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      </InsideLink.Provider>;
    }
    // GFM footnote references and back references point within the message.
    if (href?.startsWith("#") && (node?.properties?.dataFootnoteRef !== undefined || node?.properties?.dataFootnoteBackref !== undefined)) {
      return <a href={href}>{children}</a>;
    }
    // Images keep their own link to the full image.
    if (contains(node, "img")) return <>{children}</>;
    // Paths and other non-web targets are shown as plain code rather than links that would not open.
    return <InlineCode text={textOf(node) || href || ""} title={href || undefined} />;
  },
  img: ({ src, alt, title }) => <ChatImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />,
  code: ({ node }) => <InlineCode text={textOf(node)} />,
  pre: ({ node }) => {
    const code = node?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
    const classes = code?.properties?.className;
    const language = (Array.isArray(classes) ? classes : [])
      .map((name) => /^language-(.+)$/.exec(String(name))?.[1]).find(Boolean);
    const source = textOf(code ?? node).replace(/\n$/, "");
    if (language?.toLowerCase() === "mermaid") return <MermaidBlock source={source} />;
    return <CodeBlock language={language} source={source} />;
  },
  table: ({ children }) => <div className="chat-table-wrap" tabIndex={0}><table>{children}</table></div>,
  input: ({ type, checked }) => type === "checkbox"
    ? <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? "Done" : "Not done"} />
    : null,
};

// Keep local file references so images can be served from configured repositories; links never open them.
const urlTransform: UrlTransform = (url) => /^file:/i.test(url) ? url : defaultUrlTransform(url);
const remarkPlugins = [remarkGfm];

export function ChatMarkdown({ text, agentId, streaming = false, idPrefix }: {
  text: string;
  agentId?: string;
  streaming?: boolean;
  /** Keeps footnote IDs unique when several messages are on screen. */
  idPrefix?: string;
}) {
  return (
    <MarkdownContext.Provider value={{ agentId, streaming }}>
      <Markdown skipHtml remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}
        remarkRehypeOptions={idPrefix ? { clobberPrefix: `${idPrefix}-` } : undefined}>{text}</Markdown>
    </MarkdownContext.Provider>
  );
}
