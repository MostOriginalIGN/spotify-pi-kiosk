import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronLeft,
  Disc3,
  Heart,
  Home,
  Library,
  ListMusic,
  ListOrdered,
  Loader2,
  LogIn,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  X,
  Speaker
} from "lucide-react";
import "./styles.css";
import {
  applyVirtualKey,
  usePrefersVirtualKeyboard,
  VirtualKeyboard
} from "./virtualKeyboard.jsx";

const REFRESH_PLAYING_MS = 2000;
const REFRESH_IDLE_MS = 8000;
const BROWSE_TIMEOUT_MS = 30000;
const NOW_FOCUS_TIMEOUT_MS = 15000;
const DEVICE_HINT_INITIAL_MS = 10000;
const DEVICE_HINT_VISIBLE_MS = 14000;
const DIM_TIMEOUT_MS = 120000;
const BLACK_TIMEOUT_MS = 600000;
const INTERACT_MOVE_THROTTLE_MS = 400;

function App() {
  const demoMode = useMemo(
    () => new URLSearchParams(window.location.search).get("demo") || "",
    []
  );
  const isDemo = Boolean(demoMode);
  const [config, setConfig] = useState(null);
  const [player, setPlayer] = useState(null);
  const [view, setView] = useState("library");
  const [query, setQuery] = useState("");
  const [home, setHome] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailStack, setDetailStack] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const { error, showError, clearError } = useErrorToast();
  const [lastInteraction, setLastInteraction] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const playerRefreshId = useRef(0);
  const refreshTimersRef = useRef([]);
  const lastPlaybackAtRef = useRef(0);

  const item = player?.item || null;
  const albumImage = largestImage(item?.album?.images || item?.images || []);
  const artistImage = largestImage(item?.artists?.[0]?.images || []);
  const backdropImage = artistImage || albumImage;

  const isPlaying = Boolean(player?.is_playing);
  const hasPlayback = Boolean(item);
  const progress = useProgress(player, now);
  const idleFor = Date.now() - lastInteraction;
  const inactiveAudio = !isPlaying;
  const blackedOut = inactiveAudio && idleFor > BLACK_TIMEOUT_MS;
  const dimmed = inactiveAudio && idleFor > DIM_TIMEOUT_MS;

  const cancelScheduledRefreshes = useCallback(() => {
    refreshTimersRef.current.forEach((timer) => clearTimeout(timer));
    refreshTimersRef.current = [];
  }, []);

  const refreshPlayer = useCallback(async (syncEpoch) => {
    if (isDemo) return;
    const requestId = syncEpoch ?? ++playerRefreshId.current;
    try {
      const state = await api("/api/player/state");
      if (requestId !== playerRefreshId.current) return;
      setPlayer((current) => {
        const next = mergePlayerState(current, state, lastPlaybackAtRef.current);
        if (next?.item || next?.is_playing) {
          lastPlaybackAtRef.current = Date.now();
        }
        return next;
      });
      clearError();
    } catch (apiError) {
      if (requestId !== playerRefreshId.current) return;
      showError(apiError.message);
    }
  }, [clearError, isDemo, showError]);

  const schedulePlayerRefresh = useCallback((delays = [0]) => {
    if (isDemo) return;
    cancelScheduledRefreshes();
    const syncEpoch = ++playerRefreshId.current;
    delays.forEach((delay) => {
      const timer = setTimeout(() => {
        refreshTimersRef.current = refreshTimersRef.current.filter((id) => id !== timer);
        refreshPlayer(syncEpoch);
      }, delay);
      refreshTimersRef.current.push(timer);
    });
  }, [cancelScheduledRefreshes, isDemo, refreshPlayer]);

  const loadHome = useCallback(async () => {
    if (home || !config?.authenticated || isDemo) return;
    setLoading(true);
    try {
      setHome(await api("/api/browse/home"));
      clearError();
    } catch (apiError) {
      showError(apiError.message);
    } finally {
      setLoading(false);
    }
  }, [clearError, config?.authenticated, home, isDemo, showError]);

  useEffect(() => {
    if (isDemo) {
      setConfig({ configured: true, authenticated: true, deviceName: "Demo Pi", deviceHint: { enabled: true, intervalMs: 300000 } });
      setHome(demoHome());
      setPlayer(demoMode === "now" ? demoPlayer() : null);
      setView(demoMode === "now" ? "now" : "library");
      return;
    }
    api("/api/config").then(setConfig).catch((apiError) => showError(apiError.message));
    refreshPlayer();
  }, [demoMode, isDemo, refreshPlayer, showError]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(
      refreshPlayer,
      isPlaying ? REFRESH_PLAYING_MS : REFRESH_IDLE_MS
    );
    return () => clearInterval(interval);
  }, [isPlaying, refreshPlayer]);

  useEffect(() => {
    if (isDemo) return undefined;
    const source = new EventSource("/api/events");
    const refreshFromSpotify = (delays = [0, 400, 1000, 2000]) =>
      schedulePlayerRefresh(delays);
    const refreshFromLocalPlayer = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data)?.payload || null;
      } catch (_error) {
        payload = null;
      }
      setPlayer((current) => {
        const hinted = applyLocalPlayerHint(current, payload);
        if (hinted?.item || hinted?.is_playing) {
          lastPlaybackAtRef.current = Date.now();
        }
        return hinted;
      });
      if (localPlayerShouldShowNow(payload)) {
        setView("now");
        setLastInteraction(Date.now());
      }
      refreshFromSpotify(localPlayerRefreshDelays(payload));
    };
    source.addEventListener("connect-device", refreshFromLocalPlayer);
    source.addEventListener("raspotify", refreshFromLocalPlayer);
    source.addEventListener("player-state", (event) => {
      try {
        const state = JSON.parse(event.data)?.payload ?? null;
        setPlayer((current) => {
          const next = mergePlayerState(current, state, lastPlaybackAtRef.current);
          if (next?.item || next?.is_playing) {
            lastPlaybackAtRef.current = Date.now();
          }
          return next;
        });
        if (state?.item || state?.is_playing) {
          setView("now");
          setLastInteraction(Date.now());
        }
      } catch (_error) {
      }
    });
    source.addEventListener("player-command", () => refreshFromSpotify([0, 350, 900]));
    source.addEventListener("auth", () => {
      api("/api/config").then(setConfig).catch(() => {});
      refreshFromSpotify();
    });
    source.onerror = () => refreshFromSpotify([0, 500, 1500]);
    return () => {
      cancelScheduledRefreshes();
      source.close();
    };
  }, [cancelScheduledRefreshes, isDemo, schedulePlayerRefresh]);

  useEffect(() => {
    if (view === "library") loadHome();
  }, [loadHome, view]);

  useEffect(() => {
    if (isDemo) return undefined;
    if (hasPlayback || isPlaying) return undefined;
    const timeout = setTimeout(() => {
      setView((current) => (current === "now" ? "library" : current));
    }, 2000);
    return () => clearTimeout(timeout);
  }, [hasPlayback, isDemo, isPlaying]);

  useEffect(() => {
    if (view === "now" || !isPlaying) return;
    const timeout = setTimeout(() => setView("now"), BROWSE_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [view, isPlaying, lastInteraction]);

  useDragScroll();

  const interact = useCallback(() => setLastInteraction(Date.now()), []);

  const lastInteractMove = useRef(0);
  const interactOnMove = useCallback(() => {
    const t = Date.now();
    if (t - lastInteractMove.current < INTERACT_MOVE_THROTTLE_MS) return;
    lastInteractMove.current = t;
    setLastInteraction(t);
  }, []);

  const goHome = useCallback(() => {
    interact();
    setView("library");
    setSearchOpen(false);
    setDetail(null);
    setDetailStack([]);
    setSearchResults(null);
    setQuery("");
    loadHome();
  }, [interact, loadHome]);

  const backFromDetail = useCallback(() => {
    interact();
    if (detailStack.length) {
      const stack = [...detailStack];
      const previous = stack.pop();
      setDetailStack(stack);
      setDetail(previous);
      return;
    }
    setView("library");
    setDetail(null);
  }, [detailStack, interact]);

  const openNowPlaying = () => {
    interact();
    setSearchOpen(false);
    if (hasPlayback) setView("now");
  };

  const openSearch = () => {
    interact();
    setView("library");
    setSearchOpen(true);
    loadHome();
  };

  const runSearch = async (event) => {
    event?.preventDefault();
    interact();
    const nextQuery = query.trim();
    if (!nextQuery) {
      setSearchResults(null);
      setView("library");
      setSearchOpen(false);
      return;
    }
    setLoading(true);
    setDetail(null);
    try {
      setSearchResults(await api(`/api/search?q=${encodeURIComponent(nextQuery)}`));
      setView("library");
      setSearchOpen(false);
      clearError();
    } catch (apiError) {
      showError(apiError.message);
    } finally {
      setLoading(false);
    }
  };

  const openDetail = useCallback(async (kind, id, options = {}) => {
    interact();
    setLoading(true);
    try {
      const data = isDemo ? demoDetail(kind, id) : await api(`/api/${kind}/${id}`);
      if (options.push && detail) {
        setDetailStack((stack) => [...stack, detail]);
      } else if (!options.push) {
        setDetailStack([]);
      }
      setDetail({ kind, data });
      setView("detail");
      clearError();
    } catch (apiError) {
      showError(apiError.message);
    } finally {
      setLoading(false);
    }
  }, [clearError, detail, interact, isDemo, showError]);

  const command = async (url, body, method = "POST") => {
    interact();
    if (isDemo) {
      setPlayer((current) =>
        applyPlayerOptimistic(demoCommand(current, url, body), url, body)
      );
      if (shouldOpenNowPlaying(url)) setView("now");
      return;
    }

    const snapshot = player;
    setPlayer((current) => applyPlayerOptimistic(current, url, body));
    if (shouldOpenNowPlaying(url)) setView("now");

    try {
      await api(url, {
        method,
        body: body ? JSON.stringify(body) : undefined
      });
      schedulePlayerRefresh([150, 500, 1100]);
      clearError();
    } catch (apiError) {
      setPlayer(snapshot);
      showError(apiError.message);
      schedulePlayerRefresh([0, 400]);
    }
  };

  const playTrack = useCallback(async (track) => {
    if (!track?.uri) return;
    interact();
    if (isDemo) {
      setPlayer((current) =>
        applyPlayerOptimistic(demoCommand(current, "/api/player/play", { uri: track.uri }), "/api/player/play", { uri: track.uri })
      );
      setView("now");
      return;
    }
    const snapshot = player;
    setPlayer((current) =>
      current ? { ...current, item: track, is_playing: true } : current
    );
    setView("now");
    try {
      await api("/api/player/play", {
        method: "PUT",
        body: JSON.stringify({ uri: track.uri })
      });
      schedulePlayerRefresh([150, 500, 1100]);
      clearError();
    } catch (apiError) {
      setPlayer(snapshot);
      showError(apiError.message);
      schedulePlayerRefresh([0, 400]);
    }
  }, [clearError, interact, isDemo, player, schedulePlayerRefresh, showError]);

  const toggleSaved = async () => {
    const trackId = item?.id;
    if (!trackId || item?.type === "episode") return;
    interact();
    if (isDemo) {
      setPlayer((current) =>
        current?.item
          ? { ...current, item: { ...current.item, saved: !current.item.saved } }
          : current
      );
      return;
    }

    const snapshot = player;
    const nextSaved = !item?.saved;
    setPlayer((current) =>
      current?.item
        ? { ...current, item: { ...current.item, saved: nextSaved } }
        : current
    );

    try {
      await api(`/api/tracks/${trackId}/saved`, {
        method: nextSaved ? "PUT" : "DELETE"
      });
      clearError();
    } catch (apiError) {
      setPlayer(snapshot);
      showError(apiError.message);
    }
  };

  const sections = useMemo(
    () => buildSections(home, searchResults),
    [home, searchResults]
  );
  const showSideControls = view !== "now" || !hasPlayback;
  const nowFocusMode = view === "now" && hasPlayback && idleFor > NOW_FOCUS_TIMEOUT_MS;
  const deviceName = config?.deviceName || player?.device?.name || "Spotify";
  const pageTransition = usePageTransition(view);

  if (blackedOut) {
    return <button className="blackout" aria-label="Wake display" onClick={interact} />;
  }

  return (
    <main
      className={`app ${dimmed ? "is-dimmed" : ""} ${nowFocusMode ? "is-now-focused" : ""} ${showSideControls ? "browseShell" : "nowShell"}`}
      onPointerDown={interact}
      onPointerMove={interactOnMove}
    >
      {backdropImage
        ? <img className="backdrop" src={backdropImage.url} alt="" draggable={false} />
        : null
      }
      <div className="shade" />

      {showSideControls ? (
        <SideControls
          key="side-rail"
          hasPlayback={hasPlayback}
          searchActive={Boolean(searchResults)}
          searchOpen={searchOpen}
          onHome={goHome}
          onSearch={openSearch}
          onNow={openNowPlaying}
        />
      ) : null}

      {searchOpen ? (
        <SearchOverlay
          query={query}
          setQuery={setQuery}
          onSubmit={runSearch}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      {!config?.configured ? <SetupPanel envFile={config?.envFile} /> : null}
      {config?.configured && !config?.authenticated ? <LoginPanel /> : null}
      {error ? <Toast message={error} onDismiss={clearError} /> : null}
      {loading ? <Loader2 className="spinner" size={20} /> : null}

      <div className="pageStack">
        {view === "now" && hasPlayback ? (
          <PageLayer transition={pageTransition}>
            <NowPlaying
              item={item}
              image={albumImage}
              player={player}
              progress={progress}
              isDemo={isDemo}
              isPlaying={isPlaying}
              focused={nowFocusMode}
              deviceName={deviceName}
              deviceHintEnabled={config?.deviceHint?.enabled !== false}
              deviceHintIntervalMs={config?.deviceHint?.intervalMs ?? 300000}
              onCommand={command}
              onPlayTrack={playTrack}
              onToggleSaved={toggleSaved}
              onLibrary={goHome}
            />
          </PageLayer>
        ) : null}

        {view === "library" ? (
          <PageLayer transition={pageTransition}>
            <LibraryView
              sections={sections}
              searchActive={Boolean(searchResults)}
              authenticated={Boolean(config?.authenticated)}
              onPlay={command}
              onDetail={openDetail}
            />
          </PageLayer>
        ) : null}

        {view === "detail" ? (
          <PageLayer transition={pageTransition}>
            <Detail
              detail={detail}
              onPlay={command}
              onBack={backFromDetail}
              onDetail={(kind, id) => openDetail(kind, id, { push: true })}
            />
          </PageLayer>
        ) : null}
      </div>
    </main>
  );
}

function Toast({ message, onDismiss }) {
  return (
    <div className="toast" role="alert">
      <span>{message}</span>
      <button type="button" className="toastDismiss" onClick={onDismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}

function useErrorToast() {
  const [error, setError] = useState("");
  const dismissTimer = useRef(null);
  const lastShownRef = useRef({ message: "", at: 0 });

  const clearError = useCallback(() => {
    clearTimeout(dismissTimer.current);
    setError("");
  }, []);

  const showError = useCallback((message) => {
    if (!message) return;
    const now = Date.now();
    if (
      message === lastShownRef.current.message &&
      now - lastShownRef.current.at < 8000
    ) {
      return;
    }
    lastShownRef.current = { message, at: now };
    setError(message);
    clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => setError(""), 8000);
  }, []);

  useEffect(() => () => clearTimeout(dismissTimer.current), []);

  return { error, showError, clearError };
}

function PageLayer({ transition, children }) {
  return <div className={`pageLayer pageLayer--${transition}`}>{children}</div>;
}

function usePageTransition(view) {
  const prevViewRef = useRef(view);
  const [transition, setTransition] = useState("fade");

  useLayoutEffect(() => {
    const prev = prevViewRef.current;
    if (prev !== view) {
      setTransition(pageTransitionName(prev, view));
      prevViewRef.current = view;
    }
  }, [view]);

  return transition;
}

function pageTransitionName(from, to) {
  if (to === "detail") return "from-right";
  if (from === "detail") return "from-left";
  if (to === "now") return "from-bottom";
  if (from === "now") return "from-top";
  return "fade";
}

function SideControls({ hasPlayback, searchActive, searchOpen, onHome, onSearch, onNow }) {
  return (
    <nav className="sideRail" aria-label="Library controls">
      <button
        className={`railButton primary ${searchActive ? "active" : ""}`}
        onClick={onHome}
        title={searchActive ? "Home" : "Library"}
        aria-label={searchActive ? "Home" : "Library"}
      >
        {searchActive ? <Home size={20} /> : <ListMusic size={20} />}
      </button>
      <button
        className={`railButton ${searchOpen ? "active" : ""}`}
        onClick={onSearch}
        title="Search"
        aria-label="Search"
      >
        <Search size={18} />
      </button>
      {hasPlayback ? (
        <button className="railButton nowRailButton" onClick={onNow} title="Now Playing">
          <Disc3 size={18} />
        </button>
      ) : null}
    </nav>
  );
}

function SearchOverlay({ query, setQuery, onSubmit, onClose }) {
  const inputRef = useRef(null);
  const blockOsKeyboard = usePrefersVirtualKeyboard();

  useEffect(() => {
    if (!blockOsKeyboard) inputRef.current?.focus();
  }, [blockOsKeyboard]);

  const handleVirtualKey = useCallback(
    (key, options) => {
      setQuery((current) => applyVirtualKey(current, key, options));
    },
    [setQuery]
  );

  const submitFromKeyboard = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  return (
    <form className="searchOverlay" onSubmit={onSubmit}>
      <button
        type="button"
        className="searchBackdrop"
        aria-label="Close search"
        onClick={onClose}
      />
      <div className="searchSheet">
        <div className="searchSheetHeader">
          <div className="searchField">
            <Search size={18} strokeWidth={1.5} aria-hidden />
            <input
              ref={inputRef}
              value={query}
              readOnly={blockOsKeyboard}
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search Spotify"
              onChange={(event) => {
                if (!blockOsKeyboard) setQuery(event.target.value);
              }}
              onFocus={(event) => {
                if (blockOsKeyboard) event.target.blur();
              }}
              placeholder="Search Spotify"
            />
          </div>
          <button type="button" className="searchClose" onClick={onClose} title="Close">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>
        <VirtualKeyboard onKey={handleVirtualKey} onSearch={submitFromKeyboard} />
      </div>
    </form>
  );
}

function SetupPanel({ envFile }) {
  const envPath = envFile || ".env";
  return (
    <section className="setupPanel">
      <h1>Spotify setup needed</h1>
      <p>
        Fill in <code>{envPath}</code> with your Spotify client ID and secret, then restart the server.
      </p>
    </section>
  );
}

function LoginPanel() {
  return (
    <section className="setupPanel">
      <h1>Connect Spotify</h1>
      <p>Authorize the Spotify Premium account for this stereo.</p>
      <a className="loginLink" href="/api/auth/login"><LogIn size={15} /> Login with Spotify</a>
    </section>
  );
}

function QueueOverlay({ open, items, onClose, onPlayTrack }) {
  return (
    <div
      className={`queueOverlay ${open ? "is-open" : ""}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        className="queueBackdrop"
        aria-label="Close queue"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <aside className="queueDrawer" aria-label="Up next">
        <div className="queueDrawerHeader">
          <div>
            <p className="queueDrawerEyebrow">Queue</p>
            <h2>Up next</h2>
          </div>
          <button type="button" className="queueClose" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>
        <div className="queueDrawerList">
          {!items.length ? (
            <p className="queueDrawerEmpty">Nothing queued</p>
          ) : null}
          {items.map((track, index) => {
            const art = largestImage(track.album?.images || track.images || []);
            return (
              <button
                key={`${track.id || track.uri}-${index}`}
                type="button"
                className="queueRow"
                onClick={() => onPlayTrack(track)}
                title={`Play ${track.name}`}
              >
                <span className="queueIndex">{index + 1}</span>
                {art
                  ? <img className="queueArt" src={art.url} alt="" draggable={false} />
                  : <div className="queueArt emptyCover" />
                }
                <div className="queueMeta">
                  <strong>{track.name}</strong>
                  <small>{artists(track)}</small>
                </div>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function normalizeQueueEntries(data, currentId) {
  const seen = new Set();
  const items = [];
  for (const track of data?.queue || []) {
    if (!track?.id || seen.has(track.id)) continue;
    if (currentId && track.id === currentId) continue;
    seen.add(track.id);
    items.push(track);
    if (items.length >= 15) break;
  }
  return items;
}

function NowPlaying({
  item,
  image,
  player,
  progress,
  isDemo,
  isPlaying,
  focused,
  deviceName,
  deviceHintEnabled,
  deviceHintIntervalMs,
  onCommand,
  onPlayTrack,
  onToggleSaved,
  onLibrary
}) {
  const duration = item?.duration_ms || 0;
  const repeat = player?.repeat_state || "off";
  const saved = Boolean(item?.saved);
  const canSave = item?.type !== "episode" && Boolean(item?.id);
  const contextLabel = contextName(player, item);
  const remoteVolume = player?.device?.volume_percent ?? 50;
  const [volumeValue, setVolumeValue] = useState(remoteVolume);
  const [volumeVisible, setVolumeVisible] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueItems, setQueueItems] = useState([]);
  const volumeTimer = useRef(null);
  const lastCommittedVolume = useRef(remoteVolume);
  const focusActive = Boolean(focused && !queueOpen);
  const [deviceHintVisible, setDeviceHintVisible] = useState(false);

  useEffect(() => {
    if (!focusActive || !deviceHintEnabled) {
      setDeviceHintVisible(false);
      return undefined;
    }
    let hideTimer;
    const showHint = () => {
      setDeviceHintVisible(true);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setDeviceHintVisible(false), DEVICE_HINT_VISIBLE_MS);
    };
    const initial = setTimeout(showHint, DEVICE_HINT_INITIAL_MS);
    const interval = setInterval(showHint, deviceHintIntervalMs);
    return () => {
      clearTimeout(initial);
      clearTimeout(hideTimer);
      clearInterval(interval);
    };
  }, [deviceHintEnabled, deviceHintIntervalMs, focusActive]);

  useEffect(() => {
    setVolumeValue(remoteVolume);
    lastCommittedVolume.current = remoteVolume;
  }, [remoteVolume]);

  const showVolume = useCallback(() => {
    setVolumeVisible(true);
    if (volumeTimer.current) clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => setVolumeVisible(false), 3000);
  }, []);

  useEffect(() => {
    showVolume();
    return () => {
      if (volumeTimer.current) clearTimeout(volumeTimer.current);
    };
  }, [showVolume]);

  const refreshQueue = useCallback(async () => {
    if (isDemo) {
      setQueueItems(demoQueue(item?.id));
      return;
    }
    try {
      const data = await api("/api/player/queue");
      setQueueItems(normalizeQueueEntries(data, item?.id));
    } catch (_error) {
      setQueueItems([]);
    }
  }, [isDemo, item?.id]);

  useEffect(() => {
    refreshQueue();
    const interval = setInterval(refreshQueue, isPlaying ? 5000 : 12000);
    return () => clearInterval(interval);
  }, [refreshQueue, isPlaying, item?.id]);

  useEffect(() => {
    if (queueOpen) refreshQueue();
  }, [queueOpen, refreshQueue]);

  const playQueueTrack = useCallback((track) => {
    if (!track?.uri) return;
    setQueueOpen(false);
    onPlayTrack(track);
  }, [onPlayTrack]);

  const commitVolume = useCallback((value = volumeValue) => {
    const percent = Math.max(0, Math.min(100, Math.round(Number(value))));
    setVolumeValue(percent);
    if (percent === lastCommittedVolume.current) {
      showVolume();
      return;
    }
    lastCommittedVolume.current = percent;
    onCommand("/api/player/volume", { percent });
    showVolume();
  }, [onCommand, showVolume, volumeValue]);

  return (
    <section
      className={`nowPlaying ${focusActive ? "is-focused" : ""}`}
      onPointerMove={showVolume}
      onPointerDown={showVolume}
    >
      <div className={`volumeStrip ${volumeVisible ? "is-visible" : ""}`}>
        <div className="volumeIcon">
          <Volume2 size={14} />
        </div>
        <input
          aria-label="Volume"
          type="range"
          min="0"
          max="100"
          value={volumeValue}
          style={{ "--volume-percent": `${volumeValue}%` }}
          onChange={(event) => {
            setVolumeValue(Number(event.currentTarget.value));
            showVolume();
          }}
          onPointerUp={(event) => commitVolume(event.currentTarget.value)}
          onKeyUp={(event) => commitVolume(event.currentTarget.value)}
          onBlur={(event) => commitVolume(event.currentTarget.value)}
        />
      </div>

      <div className="nowHeader">
        <button className="menuMark" onClick={onLibrary} title="Library">
          <ListMusic size={18} />
        </button>
        <div className="nowContext">
          <p>Playing from {contextLabel.type}</p>
          <strong title={contextLabel.name}>{contextLabel.name}</strong>
        </div>
        <button
          type="button"
          className={`queueToggle ${queueOpen ? "active" : ""}`}
          onClick={() => setQueueOpen((open) => !open)}
          title="Queue"
          aria-label="Queue"
          aria-expanded={queueOpen}
        >
          <ListOrdered size={18} />
        </button>
      </div>

      <div className="nowHero">
        <div className="nowHeroInner">
          {image
            ? <img className="cover" src={image.url} alt={item?.name || ""} draggable={false} />
            : <div className="cover emptyCover" />
          }
          <div className="nowTrackInfo">
            <h1 title={item?.name}>{item?.name}</h1>
            <p title={artists(item)}>{artists(item)}</p>
            <small title={item?.album?.name || readableType(item)}>
              {item?.album?.name || readableType(item)}
            </small>
          </div>
        </div>
      </div>

      <QueueOverlay
        open={queueOpen}
        items={queueItems}
        onClose={() => setQueueOpen(false)}
        onPlayTrack={playQueueTrack}
      />

      <DeviceConnectHint
        deviceName={deviceName}
        visible={focusActive && deviceHintVisible}
      />

      <div className="nowControls">
        <div className="rangeRow">
          <span>{formatMs(progress)}</span>
          <input
            aria-label="Seek"
            type="range"
            min="0"
            max={duration || 1}
            value={Math.min(progress, duration || 1)}
            onChange={(event) =>
              onCommand("/api/player/seek", { positionMs: Number(event.target.value) })
            }
          />
          <span>{formatMs(duration)}</span>
        </div>

        <div className="controlRow">
          <button
            className={`smallGlyph ${saved ? "active" : ""}`}
            onClick={onToggleSaved}
            disabled={!canSave}
            title={saved ? "Remove from Liked Songs" : "Save to Liked Songs"}
          >
            <Heart size={16} fill={saved ? "currentColor" : "none"} />
          </button>
          <button
            className={`smallGlyph ${player?.shuffle_state ? "active" : ""}`}
            onClick={() => onCommand("/api/player/shuffle", { state: !player?.shuffle_state })}
            title="Shuffle"
          >
            <Shuffle size={16} />
          </button>
          <button onClick={() => onCommand("/api/player/previous")} title="Previous">
            <SkipBack size={22} />
          </button>
          <button
            className="centerPlay"
            onClick={() =>
              player?.is_playing
                ? onCommand("/api/player/pause", null, "PUT")
                : onCommand("/api/player/play", {}, "PUT")
            }
            title={player?.is_playing ? "Pause" : "Play"}
          >
            {player?.is_playing ? <Pause size={20} /> : <Play size={22} />}
          </button>
          <button onClick={() => onCommand("/api/player/next")} title="Next">
            <SkipForward size={22} />
          </button>
          <button
            className={`smallGlyph ${repeat !== "off" ? "active" : ""}`}
            onClick={() => onCommand("/api/player/repeat", { state: nextRepeat(repeat) })}
            title="Repeat"
          >
            {repeat === "track" ? <Repeat1 size={16} /> : <Repeat size={16} />}
          </button>
        </div>
      </div>
    </section>
  );
}

function DeviceConnectHint({ deviceName, visible }) {
  return (
    <div
      className={`deviceHint ${visible ? "is-visible" : ""}`}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
    >
      <div className="deviceHintScreen">
        <div className="deviceHintMark">
          <Speaker size={40} strokeWidth={1.25} />
        </div>
        <p className="deviceHintEyebrow">Spotify Connect</p>
        <h1 className="deviceHintTitle">Connect from the Spotify app</h1>
        <p className="deviceHintDevice">
          <span>Device</span>
          <strong>{deviceName}</strong>
        </p>
        <ul className="deviceHintSteps">
          <li>
            <span className="deviceHintStepNum">1</span>
            <span className="deviceHintStepText">
              Open Spotify on your phone or computer
            </span>
          </li>
          <li>
            <span className="deviceHintStepNum">2</span>
            <span className="deviceHintStepText">
              Tap the speaker icon at the bottom of the player
            </span>
          </li>
          <li>
            <span className="deviceHintStepNum">3</span>
            <span className="deviceHintStepText">
              Choose <em>{deviceName}</em> to play here
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function LibraryView({ sections, searchActive, authenticated, onPlay, onDetail }) {
  return (
    <section className="libraryView">
      <div className="libraryScroll">
        {!authenticated ? <EmptyLibrary /> : null}
        {authenticated && !sections.length ? (
          <EmptyState searchActive={searchActive} />
        ) : null}
        {sections.map((section) => (
          <MediaSection
            key={section.title}
            section={section}
            onPlay={onPlay}
            onDetail={onDetail}
          />
        ))}
      </div>
    </section>
  );
}

function EmptyLibrary() {
  return (
    <div className="readyHero">
      <div className="placeholderDisc"><Disc3 size={44} /></div>
      <div>
        <p>Spotify Kiosk</p>
        <h1>Ready to play</h1>
        <span>Log in, search, or connect from Spotify.</span>
      </div>
    </div>
  );
}

function EmptyState({ searchActive }) {
  return (
    <div className="readyHero small">
      <div className="placeholderDisc"><Library size={34} /></div>
      <div>
        <p>{searchActive ? "No results" : "Library"}</p>
        <h1>{searchActive ? "Try another search" : "Ready to play"}</h1>
      </div>
    </div>
  );
}

function MediaSection({ section, onPlay, onDetail }) {
  const isWide = section.layout === "wide";
  return (
    <div className={`section ${isWide ? "wideSection" : ""}`}>
      <div className="sectionHeader"><h2>{section.title}</h2></div>
      <div className={`rail ${isWide ? "wideRail" : ""}`} data-scroll="x">
        {section.items.map((item, index) => (
          <MediaTile
            key={`${section.title}-${item.id || item.uri || item.played_at || index}`}
            item={item}
            compact={isWide}
            onPlay={onPlay}
            onDetail={onDetail}
          />
        ))}
      </div>
    </div>
  );
}

function Detail({ detail, onPlay, onBack, onDetail }) {
  if (!detail) return null;
  if (detail.kind === "artists") {
    return (
      <ArtistDetail
        data={detail.data}
        onPlay={onPlay}
        onBack={onBack}
        onDetail={onDetail}
      />
    );
  }
  return (
    <CollectionDetail
      detail={detail}
      onPlay={onPlay}
      onBack={onBack}
    />
  );
}

function CollectionDetail({ detail, onPlay, onBack }) {
  const data = detail.data;
  const image = largestImage(data.images || data.album?.images || []);
  const uri = data.uri;
  const tracks = detail.kind === "playlists"
    ? data.tracks?.items?.map((row) => row.track).filter(Boolean) || []
    : detail.kind === "albums"
      ? data.tracks?.items || []
      : [];
  return (
    <section className="detail">
      <div className="detailHero">
        <button className="backButton" onClick={onBack} title="Back">
          <ChevronLeft size={20} />
        </button>
        {image
          ? <img src={image.url} alt="" draggable={false} />
          : <div className="tileArt" />
        }
        <div>
          <p className="eyebrow">{detail.kind.replace(/s$/, "")}</p>
          <h1>{data.name}</h1>
          <p>{artists(data) || data.owner?.display_name || readableType(data)}</p>
          <button
            className="primaryAction"
            onClick={() => onPlay("/api/player/play", { contextUri: uri }, "PUT")}
          >
            <Play size={14} /> Play
          </button>
        </div>
      </div>
      <div className="trackList">
        {tracks.slice(0, 30).map((track) => (
          <button
            key={track.id || track.uri}
            className="trackRow"
            onClick={() => onPlay("/api/player/play", { uri: track.uri }, "PUT")}
          >
            <span>{track.name}</span>
            <small>{artists(track)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function ArtistDetail({ data, onPlay, onBack, onDetail }) {
  const image = largestImage(data.images || []);
  const albums = data.albums || [];
  const topTracks = data.topTracks || [];
  const genres = data.genres?.slice(0, 3).join(" · ");

  return (
    <section className="detail">
      <div className="detailHero">
        <button className="backButton" onClick={onBack} title="Back">
          <ChevronLeft size={20} />
        </button>
        {image
          ? <img src={image.url} alt="" draggable={false} />
          : <div className="tileArt" />
        }
        <div>
          <p className="eyebrow">Artist</p>
          <h1>{data.name}</h1>
          {genres ? <p>{genres}</p> : null}
          {data.uri ? (
            <button
              className="primaryAction"
              onClick={() => onPlay("/api/player/play", { contextUri: data.uri }, "PUT")}
            >
              <Play size={14} /> Play artist
            </button>
          ) : null}
        </div>
      </div>

      {albums.length ? (
        <div className="detailSection">
          <h2 className="detailSectionHeader">Albums & singles</h2>
          <div className="rail" data-scroll="x">
            {albums.map((album) => (
              <MediaTile
                key={album.id}
                item={album}
                onPlay={onPlay}
                onDetail={onDetail}
              />
            ))}
          </div>
        </div>
      ) : null}

      {topTracks.length ? (
        <div className="detailSection">
          <h2 className="detailSectionHeader">Popular</h2>
          <div className="trackList">
            {topTracks.map((track) => (
              <button
                key={track.id || track.uri}
                className="trackRow"
                onClick={() => onPlay("/api/player/play", { uri: track.uri }, "PUT")}
              >
                <span>{track.name}</span>
                <small>{track.album?.name || artists(track)}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MediaTile({ item, compact, onPlay, onDetail }) {
  const media = item.track || item;
  const image = largestImage(media.album?.images || media.images || []);
  const type = media.type || "track";
  const open = () => {
    if (type === "track" && media.uri) {
      onPlay("/api/player/play", { uri: media.uri }, "PUT");
      return;
    }
    if (media.id && (type === "album" || type === "playlist" || type === "artist")) {
      onDetail(`${type}s`, media.id);
      return;
    }
    if (media.uri) {
      onPlay("/api/player/play", { contextUri: media.uri }, "PUT");
    }
  };
  return (
    <button type="button" className={`tile ${compact ? "compactTile" : ""}`} onClick={open}>
      {image
        ? <img className="tileArt" src={image.url} alt="" draggable={false} />
        : <div className="tileArt" />
      }
      <span title={media.name}>{media.name}</span>
      <small>{artists(media) || media.owner?.display_name || readableType(media) || type}</small>
    </button>
  );
}

function buildSections(home, searchResults) {
  const sections = [];
  if (searchResults) {
    addSection(sections, "Tracks", searchResults.tracks?.items);
    addSection(sections, "Albums", searchResults.albums?.items);
    addSection(sections, "Artists", searchResults.artists?.items);
    addSection(sections, "Playlists", searchResults.playlists?.items?.filter(Boolean));
    return sections;
  }
  addSection(sections, "Your Playlists", home?.playlists?.items);
  addSection(sections, "Recently Played", home?.recent?.items);
  addSection(sections, "Top Tracks", home?.topTracks?.items);
  addSection(sections, "Top Artists", home?.topArtists?.items);
  return sections;
}

function addSection(sections, title, items = [], options = {}) {
  const cleaned = items?.filter(Boolean) || [];
  if (cleaned.length) sections.push({ title, items: cleaned, ...options });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(json?.error || response.statusText);
  return json;
}

const HORIZONTAL_SCROLL_LOCK_PX = 12;
const HORIZONTAL_SCROLL_DOMINANCE = 1.35;

function useDragScroll() {
  useEffect(() => {
    let pending = null;
    let suppressClickUntil = 0;

    const releasePending = (event) => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (pending.captured) {
        try {
          pending.scroller.releasePointerCapture(event.pointerId);
        } catch (_error) {
        }
      }
      pending = null;
    };

    const onPointerDown = (event) => {
      if (event.button > 0) return;
      const scroller = event.target.closest('[data-scroll="x"]');
      if (!scroller) return;
      pending = {
        scroller,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: scroller.scrollLeft,
        locked: false,
        captured: false,
        moved: false
      };
    };

    const onPointerMove = (event) => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      const dx = event.clientX - pending.x;
      const dy = event.clientY - pending.y;

      if (!pending.locked) {
        if (Math.hypot(dx, dy) < HORIZONTAL_SCROLL_LOCK_PX) return;
        if (Math.abs(dy) >= Math.abs(dx) * HORIZONTAL_SCROLL_DOMINANCE) {
          pending = null;
          return;
        }
        pending.locked = true;
        try {
          pending.scroller.setPointerCapture(event.pointerId);
          pending.captured = true;
        } catch (_error) {
        }
      }

      pending.moved = true;
      pending.scroller.scrollLeft = pending.left - dx;
      event.preventDefault();
    };

    const finish = (event) => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (pending.moved) suppressClickUntil = Date.now() + 120;
      releasePending(event);
    };

    const onClick = (event) => {
      if (Date.now() > suppressClickUntil) return;
      if (event.target.closest(".tile, .trackRow, .queueRow, button, a")) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const onWheel = (event) => {
      const rail = event.target.closest('.rail[data-scroll="x"]');
      if (!rail) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        rail.scrollLeft += event.deltaX;
        event.preventDefault();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointercancel", finish);
    document.addEventListener("pointerup", finish);
    document.addEventListener("click", onClick, true);
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointercancel", finish);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("wheel", onWheel, true);
    };
  }, []);
}

function useProgress(player, now) {
  const base = player?.progress_ms || 0;
  const changedAtRef = useRef(Date.now());
  const idRef = useRef(null);
  useEffect(() => {
    const id = `${player?.item?.id || ""}:${base}:${player?.is_playing}`;
    if (id !== idRef.current) {
      idRef.current = id;
      changedAtRef.current = Date.now();
    }
  }, [player, base]);
  if (!player?.is_playing) return base;
  return base + (now - changedAtRef.current);
}

function largestImage(images) {
  return [...(images || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0] || null;
}

function artists(item) {
  return item?.artists?.map((a) => a.name).join(", ") || "";
}

function readableType(item) {
  if (!item) return "";
  return item.type ? item.type[0].toUpperCase() + item.type.slice(1) : "";
}

function contextName(player, item) {
  if (player?.context_label?.name) {
    return player.context_label;
  }

  const type = readableContextType(player?.context?.type);
  if (type === "album" && item?.album?.name) {
    return { type: "album", name: item.album.name };
  }
  if (type === "artist") {
    const name = artists(item);
    if (name) return { type: "artist", name };
  }
  if (type === "playlist") {
    return { type: "playlist", name: "Playlist" };
  }
  if (type === "podcast") {
    return { type: "podcast", name: item?.name || "Podcast" };
  }
  if (type === "your library") {
    return { type: "your library", name: "Liked Songs" };
  }

  return { type: type || "Spotify", name: player?.device?.name || "Spotify" };
}

function readableContextType(type) {
  if (type === "playlist_v2") return "playlist";
  if (type === "show") return "podcast";
  if (type === "collection") return "your library";
  return type || "Spotify";
}

function formatMs(ms = 0) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function nextRepeat(state) {
  if (state === "off") return "context";
  if (state === "context") return "track";
  return "off";
}

function shouldOpenNowPlaying(url) {
  return url.includes("/play") && !url.includes("/pause");
}

function localPlayerRefreshDelays(payload) {
  const name = payload?.PLAYER_EVENT;
  if (name === "changed" || name === "change" || name === "track_changed") {
    return [0, 300, 700, 1200, 2000, 4000, 6500];
  }
  if (name === "playing" || name === "paused" || name === "stopped" || name === "start" || name === "stop") {
    return [0, 250, 600, 1200, 2200, 4000];
  }
  return [0, 400, 1000, 2000, 3500];
}

function localPlayerShouldShowNow(payload) {
  const name = payload?.PLAYER_EVENT;
  return (
    name === "playing" ||
    name === "start" ||
    name === "started" ||
    name === "changed" ||
    name === "change" ||
    name === "track_changed" ||
    name === "preloading"
  );
}

function applyLocalPlayerHint(player, payload) {
  const event = payload?.PLAYER_EVENT;
  if (!event) return player;

  const base = player
    ? {
        ...player,
        item: player.item ? { ...player.item } : player.item,
        device: player.device ? { ...player.device } : player.device
      }
    : {
        is_playing: false,
        progress_ms: 0,
        item: null,
        shuffle_state: false,
        repeat_state: "off"
      };

  const positionMs = Number(payload.POSITION_MS);
  const progress_ms = Number.isFinite(positionMs) ? positionMs : base.progress_ms || 0;

  if (event === "playing" || event === "start" || event === "started") {
    return { ...base, is_playing: true, progress_ms };
  }
  if (event === "paused" || event === "pause") {
    return { ...base, is_playing: false, progress_ms };
  }
  if (event === "stopped" || event === "stop") {
    return { ...base, is_playing: false, progress_ms };
  }
  if (event === "changed" || event === "change" || event === "track_changed" || event === "preloading") {
    return { ...base, is_playing: true, progress_ms };
  }
  if (event === "volume_set") {
    const volume = Number(payload.VOLUME);
    if (!Number.isFinite(volume) || !base.device) return base;
    return {
      ...base,
      device: { ...base.device, volume_percent: Math.max(0, Math.min(100, volume)) }
    };
  }
  return base;
}

function mergePlayerState(current, incoming, lastPlaybackAt) {
  if (incoming?.item) return incoming;
  if (incoming?.is_playing) return incoming;
  const graceMs = 8000;
  if (current?.item && Date.now() - lastPlaybackAt < graceMs) {
    return current;
  }
  return incoming;
}

function applyPlayerOptimistic(player, url, body) {
  if (!player) return player;
  const next = { ...player, device: player.device ? { ...player.device } : undefined };

  if (url.includes("/pause")) {
    next.is_playing = false;
    return next;
  }
  if (url.includes("/play") && !url.includes("/pause")) {
    next.is_playing = true;
    return next;
  }
  if (url.includes("/shuffle")) {
    next.shuffle_state = Boolean(body?.state);
    return next;
  }
  if (url.includes("/repeat")) {
    next.repeat_state = body?.state || "off";
    return next;
  }
  if (url.includes("/seek")) {
    next.progress_ms = Number(body?.positionMs) || 0;
    return next;
  }
  if (url.includes("/volume") && next.device) {
    next.device.volume_percent = safeVolumePercent(body?.percent);
    return next;
  }
  return next;
}

function safeVolumePercent(value) {
  const int = Number(value);
  if (!Number.isFinite(int)) return 50;
  return Math.max(0, Math.min(100, Math.round(int)));
}

function demoCommand(current, url, body) {
  const base = { ...demoPlayer(), ...current };
  if (url.includes("/pause")) return { ...base, is_playing: false };
  if (url.includes("/play") && body?.uri) {
    const track = findDemoTrackByUri(body.uri);
    return { ...base, item: track, is_playing: true };
  }
  if (url.includes("/play") && !url.includes("/pause")) return { ...base, is_playing: true };
  if (url.includes("/shuffle")) return { ...base, shuffle_state: Boolean(body?.state) };
  if (url.includes("/repeat")) {
    return { ...base, repeat_state: body?.state || nextRepeat(base.repeat_state || "off") };
  }
  if (url.includes("/seek")) return { ...base, progress_ms: Number(body?.positionMs) || 0 };
  if (url.includes("/volume")) {
    return {
      ...base,
      device: { ...base.device, volume_percent: safeVolumePercent(body?.percent) }
    };
  }
  return base;
}

function findDemoTrackByUri(uri) {
  const tracks = [demoPlayer().item, ...demoQueue(null)];
  return tracks.find((track) => track.uri === uri) || demoPlayer().item;
}

function demoDetail(kind, id) {
  if (kind === "artists") return demoArtistDetail(id);
  if (kind === "albums") return demoAlbumDetail(id);
  if (kind === "playlists") {
    const playlist =
      demoHome().playlists.items.find((item) => item.id === id) ||
      demoHome().playlists.items[0];
    return {
      ...playlist,
      tracks: { items: demoQueue(null).map((track) => ({ track })) }
    };
  }
  return demoArtistDetail(id);
}

function demoAlbumItem(id, name, artist, year, colors) {
  return {
    id,
    name,
    type: "album",
    uri: `spotify:album:${id}`,
    release_date: year,
    artists: [{ name: artist }],
    images: [demoImage(name, colors)]
  };
}

function demoArtistDetail(id) {
  const artist =
    demoHome().topArtists.items.find((item) => item.id === id) ||
    demoArtist("artist-2", "Frank Sinatra", ["#091821", "#b08148", "#221927"]);
  const artistName = artist.name;
  const albums = [
    demoAlbumItem("album-cycles", "Cycles", artistName, "1968", ["#051b24", "#b4834f", "#22192a"]),
    demoAlbumItem("album-dream", "Dream", artistName, "1999", ["#142830", "#6a9ab0", "#ddd5c8"]),
    demoAlbumItem("album-pretty", "Pretty World", artistName, "2000", ["#1a3a52", "#8cb4d8", "#f0e6d8"])
  ];
  const topTracks = [
    demoTrack("sinatra-1", "My Way Of Life", artistName, "Cycles", "1968", ["#051b24", "#b4834f", "#22192a"]),
    demoTrack("sinatra-2", "Fly Me To The Moon", artistName, "It Might as Well Be Swing", "1964", ["#1a2744", "#c9a24d", "#22192a"]),
    demoTrack("sinatra-3", "The Way You Look Tonight", artistName, "Sinatra Sings...", "1962", ["#241018", "#9d7d5c", "#e8dfd0"])
  ];
  return {
    ...artist,
    genres: ["jazz", "vocal jazz", "swing"],
    albums,
    topTracks
  };
}

function demoAlbumDetail(id) {
  const artistDetail = demoArtistDetail("artist-2");
  const album = artistDetail.albums.find((item) => item.id === id) || artistDetail.albums[0];
  const tracks = artistDetail.topTracks.map((track) => ({
    ...track,
    album: { name: album.name, images: album.images }
  }));
  return { ...album, tracks: { items: tracks } };
}

function demoQueue(currentId) {
  const tracks = [
    demoTrack("q1", "Wave", "Lisa Ono", "Pretty World", "2000", ["#1a3a52", "#8cb4d8", "#f0e6d8"]),
    demoTrack("q2", "Dindi", "Lisa Ono", "Pretty World", "2000", ["#2a1f3d", "#9a7ab8", "#e8dfd0"]),
    demoTrack("q3", "Tea for Two", "Lisa Ono", "Dream", "1999", ["#142830", "#6a9ab0", "#ddd5c8"]),
    demoTrack("q4", "Sway", "Lisa Ono", "Dream", "1999", ["#301820", "#c07070", "#efe8dc"])
  ];
  return tracks.filter((track) => track.id !== currentId);
}

function demoPlayer() {
  const artistColors = ["#091821", "#b08148", "#221927"];
  return {
    is_playing: true,
    progress_ms: 174000,
    shuffle_state: true,
    repeat_state: "off",
    context: { type: "playlist", uri: "spotify:playlist:demo-jazz" },
    context_label: { type: "playlist", name: "Late Night Jazz" },
    device: { name: "Demo Pi", volume_percent: 68 },
    item: {
      ...demoTrack("demo-way", "My Way Of Life", "Frank Sinatra", "Cycles", "1968", ["#051b24", "#b4834f", "#22192a"]),
      saved: false,
      artists: [{
        name: "Frank Sinatra",
        images: [demoImage("Frank Sinatra", artistColors)]
      }]
    }
  };
}

function demoHome() {
  const owner = "MostOriginalIGN";
  const playlists = [
    demoPlaylist("playlist-chill", "Chill Vibes", owner, ["#2a3d5c", "#6b8cae", "#d4e4f0"]),
    demoPlaylist("playlist-late-night", "Late Night Jazz", owner, ["#1a1a2e", "#16213e", "#0f3460"]),
    demoPlaylist("playlist-favorites", "Favorites", owner, ["#3d2c29", "#7d5a50", "#c9a88c"]),
    demoPlaylist("playlist-road-trip", "Road Trip", owner, ["#2d5016", "#7cb342", "#fff59d"]),
    demoPlaylist("playlist-workout", "Workout Mix", owner, ["#1a1a1a", "#e53935", "#ff7043"])
  ];
  const recentTracks = [
    demoRecent("recent-1", "Vacations", "Next Exit", "Changes", "2024", ["#bad5d8", "#6c422c", "#141216"]),
    demoRecent("recent-2", "Laufey", "From The Start", "Bewitched", "2023", ["#ead0b0", "#45312b", "#111"]),
    demoRecent("recent-3", "The Marias", "No One Noticed", "Submarine", "2024", ["#95b6e9", "#231b2c", "#eef2d9"]),
    demoRecent("recent-4", "Bryant Barnes", "Adore You", "Vanity", "2024", ["#1c1b1c", "#785c47", "#cbbda6"]),
    demoRecent("recent-5", "beabadoobee", "Beaches", "This Is How Tomorrow Moves", "2024", ["#c7e4ef", "#5f7a84", "#f4f0d7"])
  ];
  const topTracks = [
    demoTrack("top-1", "Discover Weekly", "Spotify", "Your shortcut to hidden gems", "2026", ["#ff543d", "#111", "#a25bfd"]),
    demoTrack("top-2", "Daily Mix 01", "Bryant Barnes, Rocco", "Made For", "2026", ["#262018", "#6a795d", "#32e7d3"]),
    demoTrack("top-3", "Daily Mix 02", "d4vd, The Marias", "Made For", "2026", ["#f4f2e6", "#252a22", "#d7ff42"]),
    demoTrack("top-4", "Daily Mix 03", "LE SSERAFIM, NMIXX", "Made For", "2026", ["#cfedf2", "#ff523d", "#8bcae1"]),
    demoTrack("top-5", "Daily Mix 04", "Anthony Lazaro, Laufey", "Made For", "2026", ["#171717", "#db8bb8", "#efefef"])
  ];
  const artistsList = [
    demoArtist("artist-1", "Laufey", ["#a78be4", "#2b2541", "#f1d1b6"]),
    demoArtist("artist-2", "Frank Sinatra", ["#091821", "#b08148", "#221927"]),
    demoArtist("artist-3", "The Marias", ["#a8d1df", "#1f2630", "#f4e8d6"]),
    demoArtist("artist-4", "KATSEYE", ["#3450c9", "#f5d09b", "#111"])
  ];
  return {
    playlists: { items: playlists },
    recent: { items: recentTracks },
    topTracks: { items: topTracks },
    topArtists: { items: artistsList }
  };
}

function demoRecent(id, artist, name, album, year, colors) {
  return { played_at: id, track: demoTrack(id, name, artist, album, year, colors) };
}

function demoTrack(id, name, artist, album, year, colors) {
  return {
    id, name, type: "track",
    uri: `spotify:track:${id}`,
    duration_ms: 187000,
    artists: [{ name: artist }],
    album: { name: album, release_date: year, images: [demoImage(name, colors)] }
  };
}

function demoPlaylist(id, name, owner, colors) {
  return {
    id, name, type: "playlist",
    uri: `spotify:playlist:${id}`,
    owner: { display_name: owner },
    images: [demoImage(name, colors)]
  };
}

function demoArtist(id, name, colors) {
  return {
    id, name, type: "artist",
    uri: `spotify:artist:${id}`,
    images: [demoImage(name, colors)]
  };
}

function demoImage(label, [a, b, c]) {
  const short = label.split(" ").slice(0, 2).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="236" cy="58" r="74" fill="rgba(255,255,255,.1)"/><circle cx="62" cy="236" r="88" fill="rgba(0,0,0,.14)"/><text x="22" y="248" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="white">${escapeSvg(short)}</text></svg>`;
  return {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: 300, height: 300
  };
}

function escapeSvg(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;"
  })[char]);
}

createRoot(document.getElementById("root")).render(<App />);
