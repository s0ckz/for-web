type CapturedTrack = {
  stop: () => void;
  mediaStreamTrack: Pick<MediaStreamTrack, "readyState">;
};

/** The picker must finish before selecting options for the initial publication. */
export async function publishPickedScreenShare<
  T extends CapturedTrack,
  Options,
  Decision,
  Publication,
>(options: {
  acquire: () => Promise<T[]>;
  prepare: (
    tracks: T[],
  ) => Promise<{ publishOptions: Options; codecDecision: Decision }>;
  publish: (track: T, publishOptions: Options) => Promise<Publication>;
  unpublish: (track: T) => Promise<unknown>;
  isCurrent: () => boolean;
}) {
  let tracks: T[] = [];
  const published: T[] = [];
  let stopped = false;
  const stopCapture = () => {
    if (stopped) return;
    stopped = true;
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        /* best-effort cleanup */
      }
    }
  };
  const assertCurrent = () => {
    if (
      !options.isCurrent() ||
      tracks.some((track) => track.mediaStreamTrack.readyState !== "live")
    )
      throw new DOMException(
        "Screen share start is no longer current",
        "AbortError",
      );
  };
  try {
    assertCurrent();
    tracks = await options.acquire();
    assertCurrent();
    if (tracks.length === 0)
      throw new Error("Screen capture returned no tracks");
    const selection = await options.prepare(tracks);
    assertCurrent();
    // Wait for both video and audio: a late success must also be cleaned up
    // when the other publication fails or the user leaves during publishing.
    const results = await Promise.allSettled(
      tracks.map(async (track) => {
        try {
          const publication = await options.publish(
            track,
            selection.publishOptions,
          );
          if (!options.isCurrent()) stopCapture();
          return publication;
        } catch (error) {
          stopCapture();
          throw error;
        }
      }),
    );
    const publications: Publication[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        published.push(tracks[i]);
        publications.push(result.value);
      }
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    assertCurrent();
    return { publications, codecDecision: selection.codecDecision };
  } catch (error) {
    // End local capture immediately, including an unpublished microphone/mix.
    // Cleanup failures must not mask the original capture or publish error.
    stopCapture();
    await Promise.allSettled(
      published.map(async (track) => options.unpublish(track)),
    );
    throw error;
  }
}
