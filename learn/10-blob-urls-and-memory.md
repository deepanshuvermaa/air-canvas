# Blob URLs, Object URLs & In-Memory Storage

## What Are Blobs?

A `Blob` (Binary Large Object) is the browser's abstraction for immutable raw binary data. Think of it as a read-only byte array that the browser manages for you.

```typescript
// Creating a Blob from raw data
const textBlob = new Blob(['Hello, world!'], { type: 'text/plain' });
console.log(textBlob.size); // 13 bytes
console.log(textBlob.type); // "text/plain"

// Creating a Blob from multiple parts
const videoBlob = new Blob([chunk1, chunk2, chunk3], { type: 'video/webm' });
```

### Key properties of Blobs

1. **Immutable.** Once created, a Blob's contents cannot be changed. You can create new Blobs from slices of existing ones, but the original is untouched.

2. **Opaque.** You cannot index into a Blob like an array. To read its contents, you must use `FileReader`, `blob.arrayBuffer()`, `blob.text()`, or `blob.stream()`.

3. **Potentially disk-backed.** The browser may store large Blobs on disk rather than in RAM if memory pressure is high. This is transparent to your code — the Blob behaves the same either way.

4. **Reference-counted.** The browser tracks how many JavaScript references point to a Blob. When the last reference is gone and no Object URLs point to it, the Blob is eligible for garbage collection.

```
Blob internals (conceptual):
┌──────────────────────────────┐
│  type: "video/webm"         │
│  size: 1,032,576             │
│  data: [binary bytes...]     │  ← may live in RAM or on disk
│  refcount: 2                 │  ← JS variable + Object URL
└──────────────────────────────┘
```

### Blob vs ArrayBuffer vs TypedArray

These three are often confused:

| Type | Mutable? | Direct byte access? | Use case |
|---|---|---|---|
| `Blob` | No | No (must convert first) | File-like data, media, downloads |
| `ArrayBuffer` | No (the buffer itself) | Via TypedArray or DataView | Raw binary manipulation |
| `TypedArray` (e.g., `Uint8Array`) | Yes | Yes | Reading/writing individual bytes |

For Ghost Mode, `Blob` is the right choice. We never need to read or modify individual bytes of the recorded video — we just need to hand it to a `<video>` element for playback.

---

## Object URLs: blob: URIs

### The problem Object URLs solve

HTML elements like `<video>`, `<img>`, and `<a>` accept URLs as their source. They know how to fetch from `https://`, `data:`, and `file:` URIs. But a `Blob` is not a URL — it is a JavaScript object living in memory.

Object URLs bridge this gap. They create a `blob:` URI that the browser treats as a local resource, pointing directly to the in-memory Blob.

### Creating an Object URL

```typescript
const videoBlob = new Blob(chunks, { type: 'video/webm' });
const blobUrl = URL.createObjectURL(videoBlob);

console.log(blobUrl);
// "blob:https://meet.google.com/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
```

The anatomy of a blob URL:

```
blob:https://meet.google.com/a1b2c3d4-e5f6-7890-abcd-ef1234567890
│    │                        │
│    │                        └── UUID (unique identifier for this blob)
│    └── Origin of the page that created it
└── Scheme (always "blob:")
```

### The browser as a local file server

When you create an Object URL, the browser registers it in an internal mapping:

```
Browser's internal Blob URL registry:
┌──────────────────────────────────────────────┬─────────────────┐
│ blob:https://meet.google.com/a1b2c3d4...     │ → Blob (1.03 MB)│
│ blob:https://meet.google.com/f7e8d9c0...     │ → Blob (256 KB) │
└──────────────────────────────────────────────┴─────────────────┘
```

When a `<video>` element requests `blob:https://meet.google.com/a1b2c3d4...`, the browser:

1. Looks up the UUID in its registry
2. Finds the corresponding Blob
3. Serves the Blob's data to the element, just as if it were responding to an HTTP request
4. Supports range requests — the video element can seek, which is critical for looping

No network request is made. No server is involved. The data never leaves the process.

---

## The Lifecycle of a Blob URL

### Phase 1: Creation

```typescript
const blobUrl = URL.createObjectURL(blob);
// Registry: blobUrl → blob (refcount: 1 from JS variable + 1 from registry)
```

At this point, the blob is referenced by both the JavaScript variable and the URL registry.

### Phase 2: Use

```typescript
const video = document.createElement('video');
video.src = blobUrl;
// The video element begins loading data from the blob
```

The video element fetches data from the blob URL. The blob's data is read and decoded by the browser's media pipeline.

### Phase 3: Revocation

```typescript
URL.revokeObjectURL(blobUrl);
// Registry entry removed. The URL string now resolves to nothing.
```

After revocation:
- The URL string `"blob:https://..."` becomes invalid
- New loads from this URL will fail
- **Elements that already loaded the data continue working** — the video keeps playing
- The registry no longer holds a reference to the Blob

### Phase 4: Garbage collection

```typescript
// If no JS variables reference the Blob either, it can be collected
blob = null;       // Remove JS reference
// GC can now reclaim the Blob's memory
```

### The complete lifecycle in code

```typescript
// 1. Create
const blob = new Blob(chunks, { type: 'video/webm' });
const url = URL.createObjectURL(blob);

// 2. Use
video.src = url;
await video.play();

// 3. Revoke (video keeps playing — data already loaded)
URL.revokeObjectURL(url);

// 4. When video is destroyed, blob becomes eligible for GC
video.pause();
video.src = '';
video.load(); // Force release of internal media resources
```

---

## What Happens If You Forget to Revoke

This is a memory leak. The Blob stays in the browser's URL registry for the entire lifetime of the page (or until `revokeObjectURL` is finally called).

### The leak scenario

```typescript
function recordAndPlay() {
  const blob = new Blob(chunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  video.src = url;
  // url is never revoked
  // Even when this function returns and `url` goes out of scope,
  // the registry still holds a reference to the Blob
}

// Call this 10 times and you leak 10 Blobs (~10 MB)
for (let i = 0; i < 10; i++) {
  recordAndPlay();
}
```

### Why this matters for Ghost Mode

Ghost Mode can re-record multiple times (the user might press "Record Ghost" several times to get a better clip). Each recording creates a new Blob and a new Object URL. If old URLs are not revoked, old Blobs accumulate:

```
Re-record 1: Blob #1 (1 MB) — leaked if not revoked
Re-record 2: Blob #2 (1 MB) — leaked if not revoked
Re-record 3: Blob #3 (1 MB) — leaked if not revoked
...
```

### Ghost Mode's defense: revoke before re-record

```typescript
// From the ghost loop player's destroyLoop():
destroyLoop: function () {
  if (this.loopVideo) {
    this.loopVideo.pause();
    this.loopVideo.src = '';
    this.loopVideo.load();
    this.loopVideo = null;
  }
  if (this.blobUrl) {
    URL.revokeObjectURL(this.blobUrl);  // ← Critical: free the old blob
    this.blobUrl = null;
  }
  this.ready = false;
}
```

And from the LoopRecorder class:

```typescript
destroy(): void {
  if (this.currentBlobUrl) {
    URL.revokeObjectURL(this.currentBlobUrl);
    this.currentBlobUrl = null;
  }
  // ... cleanup MediaRecorder
}
```

Both the recorder and the player independently revoke their URLs. Belt and suspenders.

---

## Why Ghost Mode Does Not Use Persistent Storage

Ghost Mode's loop clip is ephemeral — it exists only while the tab is open, and it should leave no trace when the tab closes. This is a deliberate design decision driven by both privacy and engineering simplicity.

Let's examine every storage option the browser offers and why each is wrong for this use case.

### localStorage

```typescript
// Could you store the video here?
localStorage.setItem('ghostClip', ???);
```

**Why not:**

| Constraint | Problem |
|---|---|
| Size limit | 5-10 MB depending on browser. A 1 MB clip fits, but barely. |
| Data type | Strings only. You would need Base64 encoding, which inflates size by 33%. A 1 MB blob becomes a 1.33 MB string. |
| Synchronous | `setItem` blocks the main thread. Writing 1.33 MB of Base64 synchronously causes a visible jank. |
| Persistence | Data survives tab close, browser restart, even system reboot. A "ghost" clip persisting on disk is a privacy nightmare. |
| Shared | All tabs on the same origin share localStorage. Multiple AirDraw tabs would conflict. |

```typescript
// This is what it would look like — and why it is terrible
const reader = new FileReader();
reader.onload = () => {
  const base64 = reader.result as string;
  // This string is ~1.3 MB. Storing it blocks the main thread.
  localStorage.setItem('ghostClip', base64);
};
reader.readAsDataURL(blob);
```

### IndexedDB

```typescript
// IndexedDB CAN store Blobs natively
const tx = db.transaction('clips', 'readwrite');
tx.objectStore('clips').put(blob, 'ghostClip');
```

**Why not:**

| Constraint | Problem |
|---|---|
| Persistence | Data persists to disk. Same privacy concern as localStorage. |
| Complexity | Requires opening a database, creating object stores, handling upgrades, managing transactions. At least 30 lines of boilerplate for what is a single in-memory pointer. |
| Async overhead | Every read/write is asynchronous with callbacks. Overkill for ephemeral data. |
| Quota | Subject to storage quota. Browser may prompt the user or evict data. |

IndexedDB is the right tool when you need persistent structured storage. Ghost Mode needs the opposite — intentionally transient storage.

### chrome.storage (Extension Storage API)

```typescript
// The Chrome extension storage API
chrome.storage.local.set({ ghostClip: ??? });
```

**Why not:**

| Constraint | Problem |
|---|---|
| Size limit | `chrome.storage.local` has a 10 MB limit (5 MB default, 10 MB with `unlimitedStorage` permission). |
| Data type | JSON only. Cannot store Blobs or ArrayBuffers directly. You would need Base64, same as localStorage. |
| Synchronous serialization | The data is JSON-serialized and written to a LevelDB database on disk. |
| Persistence | Survives browser restart. Leaves forensic traces. |
| Cross-context | Accessible from any extension context (popup, service worker, content scripts). The clip would be accessible to debug tools. |

### Server storage (upload to a backend)

```typescript
// Upload the clip to a server
await fetch('/api/ghost-clip', { method: 'POST', body: blob });
```

**Why not:**

| Constraint | Problem |
|---|---|
| Network latency | Upload 1 MB, then download later. Adds seconds of delay. |
| Forensic traces | The clip now exists on a server, in network logs, potentially in CDN caches. |
| Privacy | You are uploading a recording of someone's webcam to a third-party server. This is a legal and ethical minefield. |
| Complexity | Requires authentication, server infrastructure, cleanup jobs, error handling for network failures. |
| Offline | Does not work without internet. AirDraw should work on local network calls too. |

### The correct answer: in-memory Blob + Object URL

```typescript
const blob = new Blob(chunks, { type: 'video/webm' });
const blobUrl = URL.createObjectURL(blob);
video.src = blobUrl;
```

**Why this is right:**

| Property | Benefit |
|---|---|
| Ephemeral | Dies when the tab closes. No persistence, no traces. |
| Fast | No serialization, no disk I/O, no network. Instant. |
| Simple | Two lines of code. No databases, no servers, no permissions. |
| Private | Data never leaves the browser process. Not written to disk (unless the OS pages memory to swap, which is outside our control). |
| Size | A 1 MB Blob is trivial for a modern browser. The live camera stream itself consumes more memory than the recording. |

---

## Memory Pressure Analysis

How much memory does Ghost Mode actually use? Let's break it down:

### The recording Blob

```
1.5 Mbps × 5.5 sec = 8.25 Megabits ≈ 1.03 MB
```

One megabyte. That is less than a single high-resolution JPEG photograph.

### The decoded video frames

When the `<video>` element plays the blob, it decodes frames into GPU memory for rendering. At any given moment, the browser keeps a few decoded frames in a buffer:

```
640 × 480 × 4 bytes (RGBA) × ~5 frames (decode buffer) ≈ 6.1 MB
```

This decoded buffer is managed by the browser's media pipeline and is the same size regardless of whether you are playing a blob URL or a live camera stream.

### The live camera stream (for comparison)

The real camera stream — the one Ghost Mode replaces — uses similar resources:

```
Camera capture buffer:     ~2-4 frames × 1.2 MB ≈ 2.4-4.8 MB
WebRTC encoding buffer:    ~3-5 frames × 1.2 MB ≈ 3.6-6.0 MB
```

Ghost Mode's blob is smaller than what the live camera already uses. The marginal memory cost of Ghost Mode is effectively the 1 MB blob itself.

### What about the chunks array during recording?

During the 5.5-second recording phase, chunks accumulate in a JavaScript array:

```
Recording at 1.5 Mbps, data requested every 500ms:
11 chunks × ~94 KB each ≈ 1.03 MB (same as final blob)

Timeline:
t=0.0s:  chunks = []                    (0 MB)
t=0.5s:  chunks = [94KB]                (0.09 MB)
t=1.0s:  chunks = [94KB, 94KB]          (0.18 MB)
...
t=5.0s:  chunks = [94KB × 10]           (0.94 MB)
t=5.5s:  chunks = [94KB × 11]           (1.03 MB)

Then: final blob created (1.03 MB)
Then: chunks = [] (freed)
```

At peak, both the chunks array and the final blob exist simultaneously: ~2 MB. Then the chunks are freed, leaving only the blob.

### Total Ghost Mode memory footprint

```
Blob:                    ~1 MB
Decoded frame buffer:    ~6 MB  (same as any video playback)
Offscreen canvas:        ~1.2 MB (for quality-drop artifact)
──────────────────────────────
Total:                   ~8 MB

For comparison:
A single Chrome tab:     ~50-150 MB
A Google Meet call:      ~200-500 MB
A single 4K photo:       ~32 MB
```

Ghost Mode's 8 MB is noise in the context of a video call.

---

## Blob URL Security Model

### Origin-scoped

Blob URLs are scoped to the origin that created them. A blob URL created by `https://meet.google.com` cannot be accessed by `https://evil.com`:

```typescript
// On https://meet.google.com
const url = URL.createObjectURL(blob);
// url = "blob:https://meet.google.com/abc123..."

// On https://evil.com — this will fail
fetch("blob:https://meet.google.com/abc123...")
  .catch(e => console.log(e));
// TypeError: Failed to fetch (cross-origin)
```

### Content scripts and blob URLs

Chrome extension content scripts run in the same origin as the page. A blob URL created by our MAIN world content script on `meet.google.com` is accessible to the page and to other content scripts on the same page. This is fine for Ghost Mode — the blob URL only needs to be used by our own `<video>` element on the same page.

### No network exposure

Blob URLs are purely local. They cannot be shared with other users, other devices, or other tabs (even tabs on the same origin). If you copy a blob URL string and paste it in another tab, it resolves to nothing — the registry is per-document.

---

## Practical Patterns

### Pattern: Record, use, cleanup

```typescript
class EphemeralRecording {
  private blobUrl: string | null = null;

  async record(stream: MediaStream, durationMs: number): Promise<string> {
    // Clean up any previous recording
    this.cleanup();

    const recorder = new MediaRecorder(stream, {
      videoBitsPerSecond: 1_500_000,
    });
    const chunks: Blob[] = [];

    return new Promise((resolve) => {
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        this.blobUrl = URL.createObjectURL(blob);
        resolve(this.blobUrl);
      };
      recorder.start(500);
      setTimeout(() => recorder.stop(), durationMs);
    });
  }

  cleanup(): void {
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}
```

### Pattern: Safe video element teardown

When destroying a video element that uses a blob URL, follow this exact sequence:

```typescript
function destroyVideo(video: HTMLVideoElement, blobUrl: string): void {
  // 1. Pause playback
  video.pause();

  // 2. Clear the source — this releases internal media resources
  video.src = '';

  // 3. Force the element to release its internal state
  video.load();

  // 4. Remove from DOM if attached
  video.remove();

  // 5. Revoke the blob URL
  URL.revokeObjectURL(blobUrl);
}
```

**Why `video.load()` after clearing `src`?** Setting `src = ''` tells the element to stop using the current source, but the element may still hold decoded frames in its internal buffer. Calling `load()` forces the element to reinitialize, releasing those buffers. Without this step, you may see ghost memory (no pun intended) hanging around until the next GC cycle.

### Pattern: Checking if a blob URL is still valid

There is no `URL.isObjectURLValid()` method. The only way to check is to try using the URL:

```typescript
async function isBlobUrlValid(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
```

Ghost Mode does not need this check. It tracks validity via its own `blobUrl` property — when it revokes, it sets the property to `null`.

---

## How Ghost Mode Uses Blob URLs

The complete flow, from recording to playback to cleanup:

```
┌─────────────────────────────────────────────────────────────────┐
│ User clicks "Record Ghost"                                       │
│                                                                   │
│ 1. LoopRecorder.record(realVideo)                                │
│    └── MediaRecorder records 5.5s from camera stream             │
│    └── ondataavailable collects chunks[]                         │
│    └── onstop creates Blob from chunks                           │
│    └── URL.createObjectURL(blob) → blobUrl                       │
│                                                                   │
│ 2. ghostLoopPlayer.prepare(realVideo)                            │
│    └── Creates <video> element                                    │
│    └── Sets video.src = blobUrl                                   │
│    └── video.muted = true                                         │
│    └── Waits for loadedmetadata                                   │
│    └── Calls video.play()                                         │
│                                                                   │
│ 3. Compositing loop draws from loop video                        │
│    └── ctx.drawImage(loopVideo, 0, 0, w, h) every frame          │
│    └── Manual loop: if currentTime >= loopEndSec → reset         │
│                                                                   │
│ 4. User re-records or disables Ghost Mode                        │
│    └── ghostLoopPlayer.destroyLoop()                             │
│    └── video.pause(); video.src = ''; video.load()               │
│    └── URL.revokeObjectURL(blobUrl)                              │
│    └── Blob becomes eligible for GC                              │
└─────────────────────────────────────────────────────────────────┘
```

The beauty of this approach: zero disk I/O, zero network traffic, zero persistent storage, zero forensic traces. The clip lives and dies entirely in RAM, exactly as Ghost Mode requires.
