/**
 * LoopRecorder — Records a short clip from the real camera stream
 * using MediaRecorder API. The clip lives entirely in RAM as a Blob URL.
 */

const RECORD_DURATION_MS = 5500;   // record slightly longer for crossfade margin
const RECORD_BITRATE    = 1_500_000; // 1.5 Mbps — lower = more believable artifacts

export interface RecordingResult {
  blobUrl: string;
  durationMs: number;
  width: number;
  height: number;
}

export class LoopRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private currentBlobUrl: string | null = null;

  /**
   * Record `RECORD_DURATION_MS` from the real camera video element.
   * Returns a blob URL pointing to the recorded WebM clip.
   */
  async record(realVideo: HTMLVideoElement): Promise<RecordingResult> {
    const stream = realVideo.srcObject as MediaStream | null;
    if (!stream) {
      throw new Error('LoopRecorder: realVideo has no srcObject');
    }

    // Get only the video tracks — audio stays live and is never recorded
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      throw new Error('LoopRecorder: no video tracks in stream');
    }

    const settings = videoTracks[0].getSettings();
    const width  = settings.width  ?? realVideo.videoWidth  ?? 640;
    const height = settings.height ?? realVideo.videoHeight ?? 480;

    // Create a video-only stream for recording
    const videoOnlyStream = new MediaStream(videoTracks);

    // Clean up any previous recording
    this.destroy();

    // Pick the best supported codec
    const mimeType = this.pickMimeType();

    return new Promise<RecordingResult>((resolve, reject) => {
      try {
        this.mediaRecorder = new MediaRecorder(videoOnlyStream, {
          mimeType,
          videoBitsPerSecond: RECORD_BITRATE,
        });
      } catch (e) {
        // Fallback: let browser choose codec
        this.mediaRecorder = new MediaRecorder(videoOnlyStream, {
          videoBitsPerSecond: RECORD_BITRATE,
        });
      }

      this.chunks = [];

      this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: mimeType || 'video/webm' });
        this.currentBlobUrl = URL.createObjectURL(blob);
        this.chunks = [];

        resolve({
          blobUrl: this.currentBlobUrl,
          durationMs: RECORD_DURATION_MS,
          width,
          height,
        });
      };

      this.mediaRecorder.onerror = (e) => {
        reject(new Error(`LoopRecorder: MediaRecorder error — ${e}`));
      };

      // Request data every 500ms for smoother chunk collection
      this.mediaRecorder.start(500);

      // Stop after the recording duration
      setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
      }, RECORD_DURATION_MS);
    });
  }

  /**
   * Revoke the blob URL and free memory.
   */
  destroy(): void {
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;
    this.chunks = [];
  }

  /**
   * Pick the best supported WebM codec.
   * VP8 is universally supported; VP9 is preferred if available.
   */
  private pickMimeType(): string {
    const candidates = [
      'video/webm; codecs=vp9',
      'video/webm; codecs=vp8',
      'video/webm',
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return 'video/webm';
  }
}
