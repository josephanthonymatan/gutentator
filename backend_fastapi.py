# backend_fastapi.py (DEBUG + LangChain splitter)
"""FastAPI backend for the Gutenberg‑annotator MVP — now using
LangChain's `RecursiveCharacterTextSplitter` for smarter, token‑aware splitting
and providing adjacent‑chunk context so that the model can produce better
annotations while still focusing on the target chunk.
"""

import os
import re
import textwrap
from itertools import count
from typing import List, Dict
from json import dumps

import httpx
import openai
from openai import AsyncOpenAI
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# NEW ---------------
from langchain.text_splitter import RecursiveCharacterTextSplitter
import tiktoken  # ensures accurate token counting for splitter
# -------------------

# ---------------------------------------------------------------------------
# ENV + OpenAI client --------------------------------------------------------
# ---------------------------------------------------------------------------

load_dotenv()
OPENAI_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_KEY:
    raise RuntimeError("OPENAI_API_KEY not found in environment")

client = AsyncOpenAI(api_key=OPENAI_KEY)
print("[INIT] OpenAI client initialised (async)")


# ---------------------------------------------------------------------------
# Pydantic models ------------------------------------------------------------
# ---------------------------------------------------------------------------

class Vocab(BaseModel):
    tricky_word: str
    definition: str

class Annotation(BaseModel):
    summary: str
    vocabs: List[Vocab]

# ---------------------------------------------------------------------------
# FastAPI app + CORS ---------------------------------------------------------
# ---------------------------------------------------------------------------

app = FastAPI(title="Guten‑Annotator MVP :: DEBUG mode + LangChain split + context")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
print("[INIT] CORS middleware configured for http://localhost:5173")

# ---------------------------------------------------------------------------
# In‑memory stores -----------------------------------------------------------
# ---------------------------------------------------------------------------

_book_id_counter = count(1)
_chunk_id_counter = count(1)
BOOKS: Dict[int, Dict] = {}
CHUNKS: Dict[int, Dict] = {}

# ---------------------------------------------------------------------------
# Helpers --------------------------------------------------------------------
# ---------------------------------------------------------------------------

GUTEN_HEADER = re.compile(r"\*\*\* START OF THIS PROJECT GUTENBERG EBOOK.+?\*\*\*", re.DOTALL)
GUTEN_FOOTER = re.compile(r"\*\*\* END OF THIS PROJECT GUTENBERG EBOOK.+", re.DOTALL)


def clean_gutenberg(raw: str) -> str:
    print("[clean_gutenberg] Raw length:", len(raw))
    raw = GUTEN_HEADER.sub("", raw)
    raw = GUTEN_FOOTER.sub("", raw)
    cleaned = raw.strip()
    print("[clean_gutenberg] Clean length:", len(cleaned))
    return cleaned


async def fetch_gutenberg_text(url: str) -> str:
    print(f"[fetch_gutenberg_text] Fetching: {url}")
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as http:
        r = await http.get(url)
        r.raise_for_status()
        print("[fetch_gutenberg_text] Status:", r.status_code)
        if "text" not in r.headers.get("Content-Type", ""):
            raise ValueError("URL does not look like plain‑text; choose ‘Plain Text UTF‑8’ link.")
        return r.text


# NEW splitter ----------------------------------------------------------------

def split_paragraphs(text: str, max_tokens: int = 300, overlap: int = 0) -> List[str]:
    """Token‑aware recursive splitter via LangChain.

    * max_tokens – approximate token cap per chunk
    * overlap    – allow some overlap to retain context between chunks
    """
    print("[split_paragraphs] Using LangChain RecursiveCharacterTextSplitter")
    encoding = tiktoken.encoding_for_model("gpt-4o-mini")

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=max_tokens,
        chunk_overlap=overlap,
        length_function=lambda txt: len(encoding.encode(txt)),
        separators=["\n\n", "\n", " ", ""],
    )

    chunks = splitter.split_text(text)
    print("[split_paragraphs] Chunks returned:", len(chunks))
    return chunks

# ---------------------------------------------------------------------------
# Additional helper to pull adjacent chunks ----------------------------------
# ---------------------------------------------------------------------------

def get_adjacent_texts(chunk_id: int) -> tuple[str, str]:
    """Return (prev_text, next_text) for the given chunk_id, or empty strings if
    at the boundary."""
    chunk = CHUNKS[chunk_id]
    book_chunks = BOOKS[chunk["book_id"]]["chunks"]
    idx = book_chunks.index(chunk_id)
    prev_text = CHUNKS[book_chunks[idx - 1]]["text"] if idx > 0 else ""
    next_text = CHUNKS[book_chunks[idx + 1]]["text"] if idx < len(book_chunks) - 1 else ""
    return prev_text, next_text

# ---------------------------------------------------------------------------
# Ingest / chunk routes ------------------------------------------------------
# ---------------------------------------------------------------------------

class IngestReq(BaseModel):
    url: str

class ChunkOut(BaseModel):
    id: int
    text: str

@app.post("/ingest")
async def ingest(payload: IngestReq):
    print("[INGEST] Received URL:", payload.url)
    text = await fetch_gutenberg_text(payload.url)
    clean = clean_gutenberg(text)
    book_id = next(_book_id_counter)
    BOOKS[book_id] = {"url": payload.url, "title": os.path.basename(payload.url), "chunks": []}
    for chunk_text in split_paragraphs(clean):
        cid = next(_chunk_id_counter)
        CHUNKS[cid] = {"book_id": book_id, "text": chunk_text, "annotation": ""}
        BOOKS[book_id]["chunks"].append(cid)
    print(f"[INGEST] Book {book_id} stored with {len(BOOKS[book_id]['chunks'])} chunks")
    return {"book_id": book_id, "chunks": BOOKS[book_id]["chunks"]}

@app.get("/chunks/{book_id}", response_model=List[ChunkOut])
async def get_chunks(book_id: int):
    print(f"[GET /chunks] book_id={book_id}")
    if book_id not in BOOKS:
        print("[GET /chunks] book not found")
        return []
    return [ChunkOut(id=cid, text=CHUNKS[cid]["text"]) for cid in BOOKS[book_id]["chunks"]]

# ---------------------------------------------------------------------------
# WebSocket for streaming annotations ---------------------------------------
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a literary annotator. Provide clear, concise commentary ONLY for the text "
    "between the markers 'BEGIN SECTION TO EXPLICATE' and 'END SECTION TO EXPLICATE'. Use the "
    "surrounding context solely to inform your analysis; do not annotate it."
    "If the relevant section seems to be webpage code or title page etc your summary should just be three dots/ellipses (...) only."
)

@app.websocket("/ws/{chunk_id}")
async def ws_annotations(websocket: WebSocket, chunk_id: int):
    await websocket.accept()

    if chunk_id not in CHUNKS:
        await websocket.close(code=4000)
        print(f"[WS] chunk_id {chunk_id} not found — closed with 4000")
        return

    chunk = CHUNKS[chunk_id]
    print(f"[WS] Connected for chunk {chunk_id}")

    try:
        goal = websocket.query_params.get(
            "goal", "Explain archaic vocabulary and summarise the paragraph if not web code ."
        )
        max_out = int(websocket.query_params.get("max_tokens", "256"))
        print(f"[WS] goal={goal!r} max_out={max_out}")

        # Pull adjacent context
        prev_text, next_text = get_adjacent_texts(chunk_id)

        # Build prompt with explicit markers
        content = textwrap.dedent(
            f"""=== CONTEXT BEFORE ===\n{prev_text}\n\n=== BEGIN SECTION TO EXPLICATE ===\n{chunk['text']}\n=== END SECTION TO EXPLICATE ===\n\n=== CONTEXT AFTER ===\n{next_text}\n\n=== TASK ===\n{goal}\n"""
        )

        print("[WS] Sending to OpenAI — approx words:", len(chunk["text"].split()))

        response = await client.responses.parse(
            model="gpt-4.1-nano-2025-04-14",
            input=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            text_format=Annotation,
        )
        annotation: Annotation = response.output_parsed
        await websocket.send_text(annotation.json())
        await websocket.close()

    except WebSocketDisconnect:
        print(f"[WS] Client disconnected for chunk {chunk_id}")
    except Exception as exc:
        print("[WS] Exception:", exc)
        await websocket.close(code=4001, reason=str(exc))
