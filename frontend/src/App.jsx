import React, { useState, useEffect, useRef, useLayoutEffect } from "react";

const BACKEND = "https://gutentator.fly.dev";


const EXAMPLE_URLS = [
  {
    title: "Pride and Prejudice",
    url: "https://www.gutenberg.org/files/1342/1342-0.txt",
  },
  {
    title: "Alice in Wonderland",
    url: "https://www.gutenberg.org/files/11/11-0.txt",
  },
  {
    title: "Frankenstein",
    url: "https://www.gutenberg.org/files/84/84-0.txt",
  },
];

const EXAMPLE_GOALS = [
  {
    label: "Explain archaic vocabulary and summarize each paragraph.",
    text: "Explain archaic vocabulary and summarize each paragraph.",
  },
  {
    label: "Pull out examples of antiquated social norms, where they exist.",
    text: "Pull out examples of antiquated social norms, where they exist. If not really prevalent in the excerpt, just give a straightforward summary of the passage.",
  },
  {
    label: "Help me keep track of all the characters and their motivations - no spoilers!.",
    text: "Help me keep track of all the characters and their motivations - no spoilers!.",
  },
];


/**
 * Two‑pane reader
 *  – left: source text with inline vocab tooltips + copy button per section
 *  – right: summaries (height‑matched so vertical scroll stays in lock‑step) + copy button
 *
 *  Alignment strategy when paragraphs >> summaries:
 *    1. Measure the rendered height of each source paragraph.
 *    2. Give the corresponding summary container a min‑height equal to that value.
 *       (Summary text sits at the top; extra space acts as a spacer.)
 *    3. Bidirectional scroll‑sync keeps panes locked.
 */
export default function App() {
  /* ------------------------------ state ------------------------------ */
  const [url,  setUrl]  = useState("");
  const [goal, setGoal] = useState("Explain archaic vocabulary and summarize each paragraph.");
  const [chunks,      setChunks]       = useState([]);   // [{id,text}]
  const [annotations, setAnnotations]  = useState({});  // {id: {summary,vocabs}}
  const [dictionary,  setDictionary]   = useState({});  // {word→definition}
  const [paraHeights, setParaHeights]  = useState({});  // {chunkId→px}
  const [tooltip,     setTooltip]      = useState({ visible:false, text:"", x:0, y:0 });

  /* --------------------------- DOM refs ----------------------------- */
  const sourceRef = useRef(null); // left pane
  const annoRef   = useRef(null); // right pane

  /* ------------------------------------------------------------------
   * helper: wrap vocabulary tokens in <span data-vocab>
   * ----------------------------------------------------------------*/
  function highlightVocab(text, vocabMap) {
    return text.split(/(\b\w+\b)/g).map((tok, idx) => {
      const key = tok.toLowerCase();
      return vocabMap[key] ? (
        <span key={idx} data-vocab={key} className="underline decoration-dotted cursor-pointer">
          {tok}
        </span>
      ) : tok;
    });
  }

  /* ----------------------------- ingest ---------------------------- */
  async function handleSubmit(e) {
    e.preventDefault();
    if (!url.trim()) return;

    const res  = await fetch(`${BACKEND}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    const cRes  = await fetch(`${BACKEND}/chunks/${data.book_id}`);
    const cData = await cRes.json();
    setChunks(cData);
  }

  /* ------------------------- websocket per chunk ------------------- */
  useEffect(() => {
    chunks.forEach((chunk) => {
      if (annotations[chunk.id]) return;
      const ws = new WebSocket(`${BACKEND.replace("http", "ws")}/ws/${chunk.id}?goal=${encodeURIComponent(goal)}`);
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          setAnnotations((prev) => ({ ...prev, [chunk.id]: parsed }));
        } catch (err) {
          console.error("Bad WS JSON", chunk.id, ev.data);
        }
      };
    });
  }, [chunks, goal, annotations]);

  /* ------------------- build global vocabulary map ----------------- */
  useEffect(() => {
    const merged = {};
    Object.values(annotations).forEach((a) => {
      (a?.vocabs || []).forEach(({ tricky_word, definition }) => {
        merged[tricky_word.toLowerCase()] = definition;
      });
    });
    setDictionary(merged);
  }, [annotations]);

  /* -------------------- measure paragraph heights ------------------ */
  useLayoutEffect(() => {
    const src = sourceRef.current;
    if (!src) return;

    const compute = () => {
      const map = {};
      src.querySelectorAll('[data-chunk]').forEach((p) => {
        map[p.dataset.chunk] = p.offsetHeight;
      });
      setParaHeights(map);
    };

    compute(); // initial

    // Recompute on resize or font zoom via ResizeObserver
    const ro = new ResizeObserver(compute);
    src.querySelectorAll('[data-chunk]').forEach((el) => ro.observe(el));
    window.addEventListener('resize', compute);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [chunks, dictionary]);

  /* ---------------- paragraph hover: highlight only ------------- */
  useEffect(() => {
    const toggle = (id, on) => {
      document.querySelectorAll(`[data-chunk="${id}"]`).forEach((el) => el.classList.toggle('bg-blue-50', on));
    };

    const mkHandlers = () => ({
      enter: (e) => {
        const node = e.target.closest('[data-chunk]');
        if (node) toggle(node.dataset.chunk, true);
      },
      leave: (e) => {
        const node = e.target.closest('[data-chunk]');
        if (node) toggle(node.dataset.chunk, false);
      }
    });

    const left = sourceRef.current;
    const right = annoRef.current;
    if (!left || !right) return;

    const L = mkHandlers();
    const R = mkHandlers();

    left.addEventListener('mouseover', L.enter);
    left.addEventListener('mouseout', L.leave);
    right.addEventListener('mouseover', R.enter);
    right.addEventListener('mouseout', R.leave);

    return () => {
      left.removeEventListener('mouseover', L.enter);
      left.removeEventListener('mouseout', L.leave);
      right.removeEventListener('mouseover', R.enter);
      right.removeEventListener('mouseout', R.leave);
    };
  }, [chunks]);

  /* ----------------------- bidirectional scroll sync --------------- */
  useEffect(() => {
    const left = sourceRef.current;
    const right = annoRef.current;
    if (!left || !right) return;

    let syncing = false;
    const sync = (from, to) => {
      if (syncing) return;
      syncing = true;
      to.scrollTop = from.scrollTop;
      syncing = false;
    };

    const onLeft = () => sync(left, right);
    const onRight = () => sync(right, left);

    left.addEventListener('scroll', onLeft);
    right.addEventListener('scroll', onRight);
    return () => {
      left.removeEventListener('scroll', onLeft);
      right.removeEventListener('scroll', onRight);
    };
  }, [paraHeights]);

  /* --------------------------- vocab tooltip ----------------------- */
  useEffect(() => {
    const enter = (e) => {
      const span = e.target.closest('[data-vocab]');
      if (!span) return;
      const key = span.dataset.vocab;
      document.querySelectorAll(`[data-vocab="${key}"]`).forEach((el) => el.classList.add('bg-yellow-200'));
      const def = dictionary[key];
      if (def) setTooltip({ visible: true, text: def, x: e.pageX + 8, y: e.pageY + 20 });
    };
    const move = (e) => {
      if (tooltip.visible) setTooltip(t => ({ ...t, x: e.pageX + 8, y: e.pageY + 20 }));
    };
    const leave = (e) => {
      const span = e.target.closest('[data-vocab]');
      if (!span) return;
      const key = span.dataset.vocab;
      document.querySelectorAll(`[data-vocab="${key}"]`).forEach((el) => el.classList.remove('bg-yellow-200'));
      setTooltip(t => ({ ...t, visible: false }));
    };

    document.body.addEventListener('mouseover', enter);
    document.body.addEventListener('mousemove', move);
    document.body.addEventListener('mouseout', leave);
    return () => {
      document.body.removeEventListener('mouseover', enter);
      document.body.removeEventListener('mousemove', move);
      document.body.removeEventListener('mouseout', leave);
    };
  }, [dictionary, tooltip.visible]);

  /* ------------------------------ render --- */
  return (
    <div className="h-screen grid grid-rows-[auto_1fr] font-sans select-text">
      {/* toolbar */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4 bg-gray-100 border-b">
        {/* URL input */}
        <div>
          <input
            className="w-full px-2 py-1 border rounded"
            placeholder="Choose any Gutenberg plain-text URL..."
            value={url}
            onChange={e => setUrl(e.target.value)}
          />
          <div className="mt-1 flex gap-2 flex-wrap">
            {EXAMPLE_URLS.map((ex, i) => (
              <button
                key={i}
                type="button"
                className="px-2 py-1 rounded-full bg-gray-200 hover:bg-gray-300 text-xs"
                onClick={() => setUrl(ex.url)}
              >
                {ex.title}
              </button>
            ))}
          </div>
        </div>
        {/* Goal/Instructions input */}
        <div>
          <input
            className="w-full px-2 py-1 border rounded"
            placeholder="Your custom instructions for the annotator..."
            value={goal}
            onChange={e => setGoal(e.target.value)}
          />
          <div className="mt-1 flex gap-2 flex-wrap">
            {EXAMPLE_GOALS.map((ex, i) => (
              <button
                key={i}
                type="button"
                className="px-2 py-1 rounded-full bg-gray-200 hover:bg-gray-300 text-xs"
                onClick={() => setGoal(ex.text)}
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>
        <button type="submit" className="self-start px-4 py-1 bg-blue-600 text-white rounded mt-2">
          Load
        </button>
      </form>


      {/* [panes and tooltip as before...] */}
      <div className="grid grid-cols-2 overflow-hidden">
        {/* left: text */}
        <div ref={sourceRef} className="p-4 overflow-y-scroll space-y-6 border-r">
          {chunks.map((ch) => (
            <p key={ch.id} data-chunk={ch.id} className="leading-relaxed">
              {highlightVocab(ch.text, dictionary)}
            </p>
          ))}
        </div>
        {/* right: summaries */}
        <div ref={annoRef} className="p-4 overflow-y-scroll space-y-6 bg-gray-50">
          {chunks.map((ch) => (
            <div
              key={ch.id}
              data-chunk={ch.id}
              style={{ minHeight: paraHeights[ch.id] || "auto" }}
              className="text-gray-800 leading-relaxed"
            >
              {annotations[ch.id]?.summary || "…"}
            </div>
          ))}
        </div>
      </div>
      {/* tooltip */}
      {tooltip.visible && (
        <div
          className="fixed z-50 max-w-xs p-2 text-sm leading-snug bg-gray-900 text-white rounded shadow-lg pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
