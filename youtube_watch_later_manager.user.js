// ==UserScript==
// @name            Watch Later & Playlist Manager for YouTube
// @name:de         Watch Later & Playlist Manager for YouTube (Später ansehen)
// @namespace       https://github.com/smiei/youtube-watchlater-manager
// @version         2.3.0
// @description     Powerful filter, sort, auto-load, and bulk-management bar for YouTube Watch Later (WL), Liked Videos (LL), and playlists. Supports both Polymer and Wiz View-Model playlists.
// @description:de  Filter-, Sortier-, Auto-Load- und Bulk-Management-Leiste für YouTube "Später ansehen" (Watch Later), "Videos, die ich mag" und Playlists.
// @author          smiei
// @license         MIT
// @homepageURL     https://github.com/smiei/youtube-watchlater-manager
// @supportURL      https://github.com/smiei/youtube-watchlater-manager/issues
// @downloadURL     https://raw.githubusercontent.com/smiei/youtube-watchlater-manager/main/youtube_watch_later_manager.user.js
// @updateURL       https://raw.githubusercontent.com/smiei/youtube-watchlater-manager/main/youtube_watch_later_manager.user.js
// @match           https://www.youtube.com/*
// @run-at          document-idle
// @grant           none
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // 1. CONFIGURATION, SELECTORS & STATE
    // =========================================================================
    const PANEL_ID = 'ytwl-pro-manager-bar';
    const WATCH_BTN_ID = 'ytwl-open-full-playlist-btn';
    const STYLE_ID = 'ytwl-pro-manager-styles';
    const FLEX_CLASS = 'ytwl-flex-playlist-contents';

    // Supports both classic Polymer playlists (WL, custom PL) and newer Wiz View-Model playlists (LL, public PL)
    const VIDEO_ITEM_SELECTOR = 'ytd-playlist-video-renderer, yt-lockup-view-model';
    const CONTINUATION_SELECTOR = 'ytd-continuation-item-renderer, yt-continuation-item-view-model';

    const state = {
        search: '',
        channel: 'ALL',
        durationQuick: 'ALL', // 'ALL' | 'LT10' | '10TO30' | 'GT30'
        maxMinutes: '',
        status: 'ALL',        // 'ALL' | 'UNWATCHED' | 'IN_PROGRESS' | 'ALMOST_DONE' | 'COMPLETED' | 'ANY_STARTED'
        hideShorts: false,
        sortBy: 'DEFAULT',    // 'DEFAULT' | 'SHORTEST' | 'LONGEST' | 'PROGRESS_DESC' | 'CHANNEL_ASC' | 'TITLE_ASC' | 'REVERSE'
        autoLoading: false,
        bulkWorking: false,
        currentPlaylistId: null,
        playlistEpoch: 1,     // Increments on every playlist switch (invalidates recycled DOM nodes)
        selectedIds: new Set(),
    };

    // WeakMap for cached metadata + original index per video DOM node
    const videoMetaMap = new WeakMap();
    let originalIndexCounter = 0;
    let playlistObserver = null;
    let observedContentsNode = null;
    let filterDebounceTimer = null;

    // =========================================================================
    // 2. DOM HELPER (100% TrustedHTML / CSP-compatible without innerHTML)
    // =========================================================================
    function el(tag, attrs = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, val] of Object.entries(attrs)) {
            if (val === undefined || val === null || val === false) continue;
            if (key === 'className') {
                node.className = val;
            } else if (key === 'textContent') {
                node.textContent = val;
            } else if (key === 'style' && typeof val === 'object') {
                Object.assign(node.style, val);
            } else if (key.startsWith('on') && typeof val === 'function') {
                node.addEventListener(key.slice(2).toLowerCase(), val);
            } else if (key === 'dataset' && typeof val === 'object') {
                Object.assign(node.dataset, val);
            } else if (key === 'checked' || key === 'disabled') {
                node[key] = Boolean(val);
            } else {
                node.setAttribute(key, String(val));
            }
        }
        const childList = Array.isArray(children) ? children : [children];
        for (const child of childList) {
            if (child === null || child === undefined || child === false) continue;
            if (typeof child === 'string' || typeof child === 'number') {
                node.appendChild(document.createTextNode(String(child)));
            } else if (child instanceof Node) {
                node.appendChild(child);
            }
        }
        return node;
    }

    function clearChildren(node) {
        while (node && node.firstChild) {
            node.removeChild(node.firstChild);
        }
    }

    // =========================================================================
    // 3. STYLE INJECTION (@grant none & TrustedTypes compatible via textContent)
    // =========================================================================
    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const css = `
            /* Flex container for non-destructive sorting via CSS order (prevents Polymer/Wiz disconnections & infinite loops) */
            #contents.${FLEX_CLASS} {
                display: flex !important;
                flex-direction: column !important;
            }
            #contents.${FLEX_CLASS} > ytd-continuation-item-renderer,
            #contents.${FLEX_CLASS} > yt-continuation-item-view-model {
                order: 9999999 !important;
            }

            /* Suppresses visible flashing of the 3-dot popup menu during automated removal */
            body.ytwl-silent-menu tp-yt-iron-dropdown,
            body.ytwl-silent-menu ytd-menu-popup-renderer,
            body.ytwl-silent-menu yt-sheet-view-model {
                opacity: 0 !important;
                pointer-events: none !important;
            }

            /* Main panel in modern YouTube Dark UI design */
            #${PANEL_ID} {
                background: rgba(24, 24, 24, 0.96);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 14px;
                padding: 14px 16px;
                margin: 8px 0 16px 0;
                color: #f1f1f1;
                font-family: "Roboto", "Arial", sans-serif;
                font-size: 13px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
                display: flex;
                flex-direction: column;
                gap: 12px;
                z-index: 20;
                position: relative;
                box-sizing: border-box;
                width: 100%;
            }

            .ytwl-row {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 10px;
            }

            .ytwl-row-between {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding-top: 8px;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
            }

            .ytwl-group {
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(255, 255, 255, 0.05);
                padding: 4px 8px;
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.07);
            }

            .ytwl-label {
                color: #aaa;
                font-size: 11px;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.4px;
                margin-right: 2px;
                user-select: none;
                white-space: nowrap;
            }

            .ytwl-input, .ytwl-select {
                background: #121212;
                color: #f1f1f1;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 13px;
                outline: none;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .ytwl-input:focus, .ytwl-select:focus {
                border-color: #3ea6ff;
                box-shadow: 0 0 0 2px rgba(62, 166, 255, 0.2);
            }
            .ytwl-input-search {
                min-width: 210px;
                flex: 1 1 210px;
            }
            .ytwl-input-num {
                width: 76px;
                text-align: center;
            }
            .ytwl-select {
                max-width: 240px;
                cursor: pointer;
            }

            .ytwl-btn {
                background: rgba(255, 255, 255, 0.1);
                color: #f1f1f1;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 6px;
                padding: 6px 11px;
                font-size: 12.5px;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.15s ease, transform 0.08s ease, border-color 0.15s ease;
                white-space: nowrap;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                user-select: none;
                text-decoration: none;
            }
            .ytwl-btn:hover {
                background: rgba(255, 255, 255, 0.18);
            }
            .ytwl-btn:active {
                transform: scale(0.98);
            }
            .ytwl-btn.active {
                background: #3ea6ff;
                color: #0f0f0f;
                border-color: #3ea6ff;
                font-weight: 600;
            }
            .ytwl-btn-accent {
                background: rgba(62, 166, 255, 0.16);
                color: #3ea6ff;
                border-color: rgba(62, 166, 255, 0.35);
            }
            .ytwl-btn-accent:hover {
                background: rgba(62, 166, 255, 0.28);
            }
            .ytwl-btn-accent.active {
                background: #ff8c00;
                color: #0f0f0f;
                border-color: #ff8c00;
            }
            .ytwl-btn-success {
                background: rgba(46, 204, 113, 0.15);
                color: #2ecc71;
                border-color: rgba(46, 204, 113, 0.35);
            }
            .ytwl-btn-success:hover {
                background: rgba(46, 204, 113, 0.28);
            }
            .ytwl-btn-success:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }
            .ytwl-btn-danger {
                background: rgba(255, 78, 69, 0.15);
                color: #ff6b6b;
                border-color: rgba(255, 78, 69, 0.35);
            }
            .ytwl-btn-danger:hover {
                background: rgba(255, 78, 69, 0.28);
            }
            .ytwl-btn-danger:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }

            .ytwl-stats {
                display: flex;
                align-items: center;
                gap: 12px;
                font-size: 13px;
                color: #ccc;
                flex-wrap: wrap;
            }
            .ytwl-stat-badge {
                background: rgba(255, 255, 255, 0.07);
                padding: 4px 10px;
                border-radius: 20px;
                font-weight: 500;
                color: #fff;
            }
            .ytwl-playlist-type-badge {
                background: rgba(62, 166, 255, 0.15);
                color: #3ea6ff;
                border: 1px solid rgba(62, 166, 255, 0.3);
                padding: 4px 10px;
                border-radius: 20px;
                font-weight: 600;
                font-size: 12px;
            }

            /* Inline controls per video (Checkbox + 1-Click actions) */
            .ytwl-item-controls {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-right: 10px;
                padding-left: 4px;
                align-self: center;
                flex-shrink: 0;
                z-index: 5;
                position: relative;
            }
            .ytwl-item-checkbox {
                width: 17px;
                height: 17px;
                accent-color: #3ea6ff;
                cursor: pointer;
                margin: 0;
            }
            .ytwl-item-trash, .ytwl-item-addwl {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #bbb;
                cursor: pointer;
                border-radius: 6px;
                padding: 5px 7px;
                font-size: 13px;
                line-height: 1;
                transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
            }
            .ytwl-item-trash:hover {
                color: #ff5252;
                background: rgba(255, 82, 82, 0.16);
                border-color: rgba(255, 82, 82, 0.35);
            }
            .ytwl-item-addwl:hover {
                color: #3ea6ff;
                background: rgba(62, 166, 255, 0.16);
                border-color: rgba(62, 166, 255, 0.35);
            }
            ytd-playlist-video-renderer.ytwl-removing,
            yt-lockup-view-model.ytwl-removing {
                opacity: 0.35 !important;
                pointer-events: none !important;
                transition: opacity 0.2s ease;
            }

            /* Direct button in the mini-playlist sidebar on /watch?v=...&list=... */
            #${WATCH_BTN_ID} {
                margin: 6px 0 4px 0;
                width: 100%;
                justify-content: center;
                box-sizing: border-box;
            }
        `;
        const styleNode = el('style', { id: STYLE_ID, textContent: css });
        (document.head || document.documentElement).appendChild(styleNode);
    }

    // =========================================================================
    // 4. FIND ACTIVE PLAYLIST CONTAINER (Polymer & Wiz View-Model compatible)
    // =========================================================================
    function isPlaylistPage() {
        return location.pathname === '/playlist';
    }

    function isWatchPageWithPlaylist() {
        return location.pathname === '/watch' && new URLSearchParams(location.search).has('list');
    }

    function getCurrentListId() {
        return new URLSearchParams(location.search).get('list') || '';
    }

    function getPlaylistTypeLabel(listId) {
        if (listId === 'WL') return '🕒 Watch Later';
        if (listId === 'LL') return '👍 Liked Videos';
        if (listId.startsWith('RD')) return '🎵 YouTube Mix';
        return '📂 Playlist';
    }

    function isNodeActuallyVisible(node) {
        if (!node || !node.isConnected) return false;
        if (node.closest('[hidden]')) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * Returns the direct child element of #contents that wraps a video item:
     * - For Polymer (<ytd-playlist-video-renderer>), it is the element itself.
     * - For Wiz (<yt-lockup-view-model>), it is the wrapping <div style="margin-bottom: 16px;">.
     */
    function getSortableRow(videoEl, contents) {
        if (!videoEl) return null;
        if (!contents) contents = getPlaylistContentsContainer();
        if (!contents) return videoEl;
        let curr = videoEl;
        while (curr && curr.parentElement && curr.parentElement !== contents) {
            curr = curr.parentElement;
        }
        return (curr && curr.parentElement === contents) ? curr : videoEl;
    }

    /**
     * Reliably finds the currently VISIBLE playlist container (host + contents).
     * Supports both:
     * 1. Polymer: ytd-playlist-video-list-renderer > #contents > ytd-playlist-video-renderer
     * 2. Wiz View-Model (e.g. Liked Videos LL & public playlists):
     *    yt-item-section-renderer > #contents > div > yt-lockup-view-model
     */
    function getActivePlaylistContainers() {
        if (!isPlaylistPage()) return null;

        // 1. Primary: Locate #contents via an actually visible video element
        const allVideos = Array.from(document.querySelectorAll(VIDEO_ITEM_SELECTOR));
        const visibleVideo = allVideos.find(v => isNodeActuallyVisible(v));
        if (visibleVideo) {
            const contents = visibleVideo.closest('#contents') || visibleVideo.parentElement;
            if (contents && contents.parentElement) {
                return { host: contents.parentElement, contents };
            }
        }

        // 2. Fallback: Check visible list renderers (even while videos are still loading)
        const candidateRenderers = Array.from(
            document.querySelectorAll('ytd-playlist-video-list-renderer, yt-item-section-renderer, ytd-item-section-renderer')
        );
        for (const lr of candidateRenderers) {
            if (isNodeActuallyVisible(lr)) {
                const contents = lr.querySelector('#contents');
                if (contents && contents.parentElement) {
                    return { host: contents.parentElement, contents };
                }
            }
        }

        return null;
    }

    function getPlaylistContentsContainer() {
        const active = getActivePlaylistContainers();
        return active ? active.contents : null;
    }

    function getAllVideoElements(contents) {
        const root = contents || getPlaylistContentsContainer();
        if (!root) return [];
        return Array.from(root.querySelectorAll(VIDEO_ITEM_SELECTOR));
    }

    // =========================================================================
    // 5. ROBUST DATA EXTRACTION (Polymer el.data + Wiz View-Model + DOM)
    // =========================================================================
    function parseDurationToSeconds(rawText) {
        if (!rawText || typeof rawText !== 'string') return 0;
        const cleaned = rawText.replace(/\s+/g, '').trim();
        // Only accept valid time formats like "4:12" or "1:05:30" (ignores "SHORTS", "LIVE", "PREMIERE")
        if (!/^\d+(?::\d{1,2})+$/.test(cleaned)) return 0;
        const parts = cleaned.split(':').map(Number);
        if (parts.some(Number.isNaN)) return 0;
        if (parts.length === 3) {
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        if (parts.length === 2) {
            return parts[0] * 60 + parts[1];
        }
        return parts[0] || 0;
    }

    function formatSecondsHuman(totalSeconds) {
        if (!totalSeconds || totalSeconds <= 0) return '0 min';
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes} min`;
    }

    // Supports both direct page context and Firefox XrayWrapper (wrappedJSObject)
    function getPolymerData(domNode) {
        if (!domNode) return null;
        const raw = domNode.wrappedJSObject || domNode;
        const d = raw.data || raw.__data?.data || raw.__data || domNode.data || null;
        if (d && typeof d === 'object' && Object.keys(d).length > 0) return d;
        return null;
    }

    function extractDomVideoId(videoEl) {
        const linkEl = videoEl.querySelector(
            'a#video-title, a#thumbnail, a.ytLockupMetadataViewModelTitle, a.ytLockupViewModelContentImage, a[href*="watch?v="], a[href*="/shorts/"]'
        );
        const href = linkEl?.getAttribute('href') || '';
        const m = href.match(/[?&]v=([^&]+)/) || href.match(/\/shorts\/([^/?&]+)/);
        if (m) return m[1];

        // Fallback for Wiz content-id-<VIDEO_ID> class
        const hostDiv = videoEl.querySelector('[class*="content-id-"]');
        if (hostDiv) {
            const cm = hostDiv.className.match(/content-id-([A-Za-z0-9_-]{11})/);
            if (cm) return cm[1];
        }
        return '';
    }

    function extractVideoMeta(videoEl) {
        const pData = getPolymerData(videoEl);
        const currentVid = (pData?.videoId ? String(pData.videoId) : '') || extractDomVideoId(videoEl);

        let meta = videoMetaMap.get(videoEl);

        // Reset cached metadata when switching playlists in SPA navigation (WL -> LL -> PL)
        if (
            !meta ||
            meta.epoch !== state.playlistEpoch ||
            (currentVid && meta.videoId && meta.videoId !== currentVid)
        ) {
            meta = {
                epoch: state.playlistEpoch,
                originalIndex: originalIndexCounter++,
                videoId: currentVid,
                setVideoId: '',
                title: '',
                titleLower: '',
                channel: '',
                channelLower: '',
                durationSec: 0,
                progressPct: 0,
                isShort: false,
                canRemove: false,
                removeEndpoint: null,
            };
            videoMetaMap.set(videoEl, meta);
        }

        const listId = getCurrentListId();

        // 1. Video ID, SetVideoId & RemoveEndpoint (for WL, custom playlists & Liked Videos LL)
        if (pData) {
            if (!meta.videoId && pData.videoId) meta.videoId = String(pData.videoId);
            if (!meta.setVideoId && pData.setVideoId) meta.setVideoId = String(pData.setVideoId);

            if (!meta.removeEndpoint && Array.isArray(pData.menu?.menuRenderer?.items)) {
                for (const item of pData.menu.menuRenderer.items) {
                    const ep = item?.menuServiceItemRenderer?.serviceEndpoint;
                    if (!ep) continue;

                    const actions = ep?.playlistEditEndpoint?.actions;
                    const isPlaylistRemove = Array.isArray(actions) && actions.some(a => a.action && a.action.includes('REMOVE'));
                    const isLikeRemove = Boolean(ep?.likeEndpoint && ep.likeEndpoint.status === 'INDIFFERENT');

                    if (isPlaylistRemove || isLikeRemove) {
                        try {
                            meta.removeEndpoint = JSON.parse(JSON.stringify(ep));
                        } catch (_) {
                            meta.removeEndpoint = ep;
                        }
                        meta.canRemove = true;
                        break;
                    }
                }
            }
        }

        if (listId === 'WL' || listId === 'LL' || meta.setVideoId) {
            meta.canRemove = true;
        }

        // 2. Video Title (Polymer + Wiz View-Model + Legacy DOM)
        if (!meta.title || meta.title === 'Unknown Video') {
            const polyTitle = (
                pData?.title?.runs?.map(r => r.text).join('') ||
                pData?.title?.simpleText ||
                ''
            ).trim();
            const titleEl = videoEl.querySelector(
                '#video-title, a.ytLockupMetadataViewModelTitle, h3.ytLockupMetadataViewModelHeadingReset[title]'
            );
            const domTitle = (titleEl?.textContent || titleEl?.getAttribute('title') || '').trim();
            meta.title = polyTitle || domTitle || 'Unknown Video';
            meta.titleLower = meta.title.toLowerCase();
        }

        // 3. Channel Name (Polymer + Wiz View-Model + Legacy DOM)
        if (!meta.channel || meta.channel === 'Unknown Channel') {
            const polyChannel = (
                pData?.shortBylineText?.runs?.[0]?.text ||
                pData?.longBylineText?.runs?.[0]?.text ||
                ''
            ).trim();
            const chanEl = videoEl.querySelector('ytd-channel-name #text')
                || videoEl.querySelector('ytd-channel-name a')
                || videoEl.querySelector('ytd-channel-name')
                || videoEl.querySelector('.ytContentMetadataViewModelMetadataRow a[href^="/@"]')
                || videoEl.querySelector('.ytContentMetadataViewModelMetadataRow a[href^="/channel/"]')
                || videoEl.querySelector('.ytContentMetadataViewModelMetadataRow .ytContentMetadataViewModelMetadataText');
            const domChannel = (chanEl?.textContent || '').trim().split('\n')[0].trim();
            meta.channel = polyChannel || domChannel || 'Unknown Channel';
            meta.channelLower = meta.channel.toLowerCase();
        }

        // 4. Video Duration (Polymer lengthSeconds + Wiz .ytBadgeShapeText + Legacy DOM)
        if (!meta.durationSec) {
            let sec = 0;
            if (pData?.lengthSeconds) {
                const parsed = parseInt(pData.lengthSeconds, 10);
                if (!Number.isNaN(parsed) && parsed > 0) sec = parsed;
            }
            if (!sec && pData?.lengthText?.simpleText) {
                sec = parseDurationToSeconds(pData.lengthText.simpleText);
            }
            if (!sec && Array.isArray(pData?.thumbnailOverlays)) {
                for (const ov of pData.thumbnailOverlays) {
                    const txt = ov?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText
                        || ov?.thumbnailOverlayTimeStatusRenderer?.text?.runs?.[0]?.text;
                    if (txt) {
                        sec = parseDurationToSeconds(txt);
                        if (sec > 0) break;
                    }
                }
            }
            if (!sec) {
                const badgeNodes = videoEl.querySelectorAll(
                    'badge-shape .yt-badge-shape__text, badge-shape .ytBadgeShapeText, ytd-thumbnail-overlay-time-status-renderer #text, span.ytd-thumbnail-overlay-time-status-renderer'
                );
                for (const b of badgeNodes) {
                    const parsed = parseDurationToSeconds(b.textContent);
                    if (parsed > 0) {
                        sec = parsed;
                        break;
                    }
                }
            }
            meta.durationSec = sec;
        }

        // 5. Shorts Detection
        const titleLink = videoEl.querySelector(
            'a#video-title, a#thumbnail, a.ytLockupMetadataViewModelTitle, a.ytLockupViewModelContentImage'
        );
        const href = titleLink?.getAttribute('href') || '';
        if (href.includes('/shorts/')) {
            meta.isShort = true;
        } else if (Array.isArray(pData?.thumbnailOverlays)) {
            if (pData.thumbnailOverlays.some(ov => ov?.thumbnailOverlayTimeStatusRenderer?.style === 'SHORTS')) {
                meta.isShort = true;
            }
        }

        // 6. Watched Progress (%) — combines Legacy DOM (#progress), Wiz View-Model & Polymer
        let domProgress = 0;
        const progressEl = videoEl.querySelector(
            'ytd-thumbnail-overlay-resume-playback-renderer #progress, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment, #progress'
        );
        if (progressEl && progressEl.style && progressEl.style.width) {
            const w = parseFloat(progressEl.style.width);
            if (!Number.isNaN(w)) domProgress = w;
        }

        let polyProgress = 0;
        if (Array.isArray(pData?.thumbnailOverlays)) {
            for (const ov of pData.thumbnailOverlays) {
                const p = ov?.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched;
                if (typeof p === 'number' && !Number.isNaN(p)) {
                    polyProgress = p;
                    break;
                }
            }
        }

        meta.progressPct = Math.max(domProgress, polyProgress);

        return meta;
    }

    // =========================================================================
    // 6. INLINE VIDEO CONTROLS (Checkbox + 1-Click Remove + 1-Click Watch Later)
    // =========================================================================
    function ensureVideoInlineControls(videoEl, meta) {
        const listId = getCurrentListId();
        const existing = videoEl.querySelector('.ytwl-item-controls');
        if (existing) {
            const cb = existing.querySelector('.ytwl-item-checkbox');
            if (cb) {
                cb.dataset.vid = meta.videoId || '';
                cb.checked = meta.videoId ? state.selectedIds.has(meta.videoId) : false;
            }
            const trashBtn = existing.querySelector('.ytwl-item-trash');
            if (trashBtn) {
                trashBtn.style.display = meta.canRemove ? '' : 'none';
            }
            const addWlBtn = existing.querySelector('.ytwl-item-addwl');
            if (addWlBtn) {
                addWlBtn.style.display = listId !== 'WL' ? '' : 'none';
            }
            return;
        }

        const checkbox = el('input', {
            type: 'checkbox',
            className: 'ytwl-item-checkbox',
            title: 'Select video for bulk action',
            dataset: { vid: meta.videoId || '' },
            checked: meta.videoId ? state.selectedIds.has(meta.videoId) : false,
            onChange: (e) => {
                e.stopPropagation();
                const vid = checkbox.dataset.vid || extractVideoMeta(videoEl).videoId;
                if (!vid) return;
                if (checkbox.checked) {
                    state.selectedIds.add(vid);
                } else {
                    state.selectedIds.delete(vid);
                }
                updateSelectionButtonsUI();
            }
        });

        // 1-Click "Add to Watch Later" (shown in Liked Videos & other playlists)
        const addWlBtn = el('button', {
            type: 'button',
            className: 'ytwl-item-addwl',
            style: { display: listId !== 'WL' ? '' : 'none' },
            title: 'Add to Watch Later (1-Click)',
            textContent: '🕒+',
            onClick: async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const m = extractVideoMeta(videoEl);
                if (!m.videoId) return;
                const ok = await addVideoToWatchLater(videoEl, m.videoId);
                if (ok) {
                    addWlBtn.textContent = '✅';
                    setTimeout(() => {
                        if (addWlBtn.isConnected) addWlBtn.textContent = '🕒+';
                    }, 2000);
                }
            }
        });

        // 1-Click "Remove from this playlist / Liked Videos"
        const trashBtn = el('button', {
            type: 'button',
            className: 'ytwl-item-trash',
            style: { display: meta.canRemove ? '' : 'none' },
            title: listId === 'LL'
                ? 'Remove from Liked Videos (1-Click)'
                : 'Remove from this playlist (1-Click)',
            textContent: '🗑️',
            onClick: async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await removeSingleVideo(videoEl);
            }
        });

        const ctrlWrap = el('div', { className: 'ytwl-item-controls' }, [checkbox, addWlBtn, trashBtn]);

        // Placement in Polymer (before #index-container) or Wiz View-Model (inside .ytLockupViewModelHost)
        const indexCont = videoEl.querySelector('#index-container');
        const lockupHost = videoEl.querySelector('.ytLockupViewModelHost');
        if (indexCont && indexCont.parentNode) {
            indexCont.parentNode.insertBefore(ctrlWrap, indexCont);
        } else if (lockupHost) {
            lockupHost.insertBefore(ctrlWrap, lockupHost.firstChild);
        } else {
            videoEl.insertBefore(ctrlWrap, videoEl.firstChild);
        }
    }

    // =========================================================================
    // 7. VIDEO ACTIONS: REMOVE (WL, PL & LL) + ADD TO WATCH LATER
    // =========================================================================
    function dispatchYtServiceRequest(targetNode, serviceEndpoint) {
        const rawDetail = {
            actionName: 'yt-service-request',
            args: [targetNode, serviceEndpoint],
            optionalAction: false
        };
        const eventDetail = (typeof cloneInto === 'function')
            ? cloneInto(rawDetail, document.defaultView)
            : rawDetail;

        targetNode.dispatchEvent(new CustomEvent('yt-action', {
            bubbles: true,
            composed: true,
            detail: eventDetail
        }));
    }

    async function addVideoToWatchLater(videoEl, videoId) {
        if (!videoId) return false;
        const serviceEndpoint = {
            clickTrackingParams: '',
            commandMetadata: {
                webCommandMetadata: {
                    sendPost: true,
                    apiUrl: '/youtubei/v1/browse/edit_playlist'
                }
            },
            playlistEditEndpoint: {
                playlistId: 'WL',
                actions: [{
                    action: 'ACTION_ADD_VIDEO',
                    addedVideoId: videoId
                }]
            }
        };
        try {
            dispatchYtServiceRequest(document.querySelector('ytd-app') || videoEl || document.body, serviceEndpoint);
            return true;
        } catch (e) {
            console.warn('[YTWL Manager] Failed to add video to Watch Later:', e);
            return false;
        }
    }

    async function removeSingleVideo(videoEl) {
        if (!videoEl || !videoEl.isConnected) return false;
        const meta = extractVideoMeta(videoEl);
        const playlistId = getCurrentListId() || 'WL';
        const rowEl = getSortableRow(videoEl);
        videoEl.classList.add('ytwl-removing');

        // Strategy 1: Direct YouTube internal 'yt-action' (yt-service-request) event
        let serviceEndpoint = meta.removeEndpoint;

        if (!serviceEndpoint) {
            if (playlistId === 'LL' && meta.videoId) {
                serviceEndpoint = {
                    clickTrackingParams: '',
                    commandMetadata: {
                        webCommandMetadata: {
                            sendPost: true,
                            apiUrl: '/youtubei/v1/like/removelike'
                        }
                    },
                    likeEndpoint: {
                        status: 'INDIFFERENT',
                        target: { videoId: meta.videoId }
                    }
                };
            } else if (meta.setVideoId) {
                serviceEndpoint = {
                    clickTrackingParams: '',
                    commandMetadata: {
                        webCommandMetadata: {
                            sendPost: true,
                            apiUrl: '/youtubei/v1/browse/edit_playlist'
                        }
                    },
                    playlistEditEndpoint: {
                        playlistId,
                        actions: [{
                            action: 'ACTION_REMOVE_VIDEO',
                            setVideoId: meta.setVideoId,
                            removedVideoId: meta.videoId || undefined
                        }]
                    }
                };
            }
        }

        if (serviceEndpoint) {
            try {
                dispatchYtServiceRequest(document.querySelector('ytd-app') || videoEl, serviceEndpoint);
                await new Promise(r => setTimeout(r, 160));
                if (!videoEl.isConnected || videoEl.hasAttribute('is-dismissed') || videoEl.hidden) {
                    if (meta.videoId) state.selectedIds.delete(meta.videoId);
                    applyFiltersAndSort();
                    return true;
                }
            } catch (_) {
                // Fallback to Strategy 2
            }
        }

        // Strategy 2: Language-agnostic silent click via the 3-dot menu (Polymer & Wiz View-Model)
        const menuBtn = videoEl.querySelector(
            'ytd-menu-renderer yt-icon-button#button button, ytd-menu-renderer #button button, ytd-menu-renderer button, .ytLockupMetadataViewModelMenuButton button'
        );
        if (menuBtn) {
            document.body.classList.add('ytwl-silent-menu');
            try {
                menuBtn.click();
                await new Promise(r => setTimeout(r, 180));

                const popupItems = Array.from(
                    document.querySelectorAll(
                        'ytd-menu-popup-renderer ytd-menu-service-item-renderer, yt-sheet-view-model yt-list-item-view-model, tp-yt-iron-dropdown yt-list-item-view-model'
                    )
                );

                // First search language-independently via Polymer Action / LikeEndpoint / Icon
                let targetItem = popupItems.find(item => {
                    const itemData = getPolymerData(item);
                    const ep = itemData?.serviceEndpoint;
                    const acts = ep?.playlistEditEndpoint?.actions;
                    if (Array.isArray(acts) && acts.some(a => a.action && a.action.includes('REMOVE'))) {
                        return true;
                    }
                    if (ep?.likeEndpoint && ep.likeEndpoint.status === 'INDIFFERENT') {
                        return true;
                    }
                    return itemData?.icon?.iconType === 'DELETE';
                });

                // Multi-language text fallback (EN/DE/FR/ES/IT)
                if (!targetItem) {
                    targetItem = popupItems.find(item =>
                        /remove|delete|entfernen|löschen|supprimer|eliminar|rimuovi/i.test(item.textContent || '')
                    );
                }

                if (targetItem) {
                    const clickable = targetItem.querySelector('tp-yt-paper-item, button, [role="menuitem"]') || targetItem;
                    clickable.click();
                    await new Promise(r => setTimeout(r, 150));
                    if (rowEl && rowEl.isConnected) {
                        rowEl.remove();
                    } else if (videoEl.isConnected) {
                        videoEl.remove();
                    }
                    if (meta.videoId) state.selectedIds.delete(meta.videoId);
                    applyFiltersAndSort();
                    return true;
                } else {
                    document.body.click();
                }
            } finally {
                document.body.classList.remove('ytwl-silent-menu');
            }
        }

        // If on list=LL Strategy 1 sent the API call but Wiz did not remove the DOM node automatically:
        if (playlistId === 'LL' && serviceEndpoint) {
            if (rowEl && rowEl.isConnected) rowEl.remove();
            if (meta.videoId) state.selectedIds.delete(meta.videoId);
            applyFiltersAndSort();
            return true;
        }

        videoEl.classList.remove('ytwl-removing');
        return false;
    }

    // =========================================================================
    // 8. FILTERING, CHANNEL DROPDOWN & SORTING LOGIC
    // =========================================================================
    function matchesFilters(meta) {
        if (state.search) {
            const q = state.search.toLowerCase();
            if (!meta.titleLower.includes(q) && !meta.channelLower.includes(q)) {
                return false;
            }
        }

        if (state.channel !== 'ALL' && meta.channel !== state.channel) {
            return false;
        }

        if (state.hideShorts && meta.isShort) {
            return false;
        }

        const durMin = meta.durationSec / 60;
        if (state.durationQuick === 'LT10') {
            if (meta.durationSec <= 0 || durMin >= 10) return false;
        } else if (state.durationQuick === '10TO30') {
            if (durMin < 10 || durMin > 30) return false;
        } else if (state.durationQuick === 'GT30') {
            if (durMin <= 30) return false;
        }

        if (state.maxMinutes !== '') {
            const maxMinVal = parseFloat(state.maxMinutes);
            if (!Number.isNaN(maxMinVal) && maxMinVal > 0) {
                if (meta.durationSec <= 0 || durMin > maxMinVal) return false;
            }
        }

        const p = meta.progressPct;
        switch (state.status) {
            case 'UNWATCHED':
                if (p > 0) return false;
                break;
            case 'IN_PROGRESS':
                if (p <= 0 || p >= 80) return false;
                break;
            case 'ANY_STARTED':
                if (p <= 0) return false;
                break;
            case 'ALMOST_DONE':
                if (p < 80) return false;
                break;
            case 'COMPLETED':
                if (p < 98) return false;
                break;
        }

        return true;
    }

    function updateChannelDropdown(channelCounts) {
        const selectEl = document.getElementById('ytwl-channel-select');
        if (!selectEl) return;

        const sortedChannels = Array.from(channelCounts.entries())
            .sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }));

        const currentVal = state.channel;
        clearChildren(selectEl);

        selectEl.appendChild(el('option', {
            value: 'ALL',
            textContent: `All Channels (${sortedChannels.length})`
        }));

        let currentStillExists = currentVal === 'ALL';
        for (const [channelName, count] of sortedChannels) {
            if (channelName === currentVal) currentStillExists = true;
            selectEl.appendChild(el('option', {
                value: channelName,
                textContent: `${channelName} (${count})`
            }));
        }

        if (!currentStillExists) {
            state.channel = 'ALL';
        }
        selectEl.value = state.channel;
    }

    function applyFiltersAndSort() {
        const contents = getPlaylistContentsContainer();
        if (!contents) return;

        contents.classList.add(FLEX_CLASS);

        const videoNodes = getAllVideoElements(contents);
        const channelCounts = new Map();
        const itemsWithMeta = [];

        let visibleCount = 0;
        let visibleDurationSec = 0;
        let anyRemovable = false;

        for (const videoEl of videoNodes) {
            const meta = extractVideoMeta(videoEl);
            const rowEl = getSortableRow(videoEl, contents);
            if (meta.canRemove) anyRemovable = true;
            ensureVideoInlineControls(videoEl, meta);

            if (meta.channel) {
                channelCounts.set(meta.channel, (channelCounts.get(meta.channel) || 0) + 1);
            }

            const visible = matchesFilters(meta);
            if (rowEl) rowEl.style.display = visible ? '' : 'none';
            if (rowEl !== videoEl) videoEl.style.display = visible ? '' : 'none';

            if (visible) {
                visibleCount++;
                visibleDurationSec += meta.durationSec || 0;
            }

            itemsWithMeta.push({ videoEl, rowEl, meta });
        }

        if (state.sortBy === 'DEFAULT') {
            for (const { rowEl, videoEl } of itemsWithMeta) {
                if (rowEl) rowEl.style.order = '';
                if (rowEl !== videoEl) videoEl.style.order = '';
            }
        } else {
            const sorted = [...itemsWithMeta].sort((a, b) => {
                switch (state.sortBy) {
                    case 'SHORTEST': {
                        const da = a.meta.durationSec || Number.MAX_SAFE_INTEGER;
                        const db = b.meta.durationSec || Number.MAX_SAFE_INTEGER;
                        return da - db || (a.meta.originalIndex - b.meta.originalIndex);
                    }
                    case 'LONGEST': {
                        const da = a.meta.durationSec || -1;
                        const db = b.meta.durationSec || -1;
                        return db - da || (a.meta.originalIndex - b.meta.originalIndex);
                    }
                    case 'PROGRESS_DESC':
                        return (b.meta.progressPct - a.meta.progressPct) || (a.meta.originalIndex - b.meta.originalIndex);
                    case 'CHANNEL_ASC':
                        return a.meta.channel.localeCompare(b.meta.channel, 'en', { sensitivity: 'base' })
                            || (a.meta.originalIndex - b.meta.originalIndex);
                    case 'TITLE_ASC':
                        return a.meta.title.localeCompare(b.meta.title, 'en', { sensitivity: 'base' })
                            || (a.meta.originalIndex - b.meta.originalIndex);
                    case 'REVERSE':
                        return b.meta.originalIndex - a.meta.originalIndex;
                    default:
                        return a.meta.originalIndex - b.meta.originalIndex;
                }
            });

            sorted.forEach((item, idx) => {
                const target = item.rowEl || item.videoEl;
                target.style.order = String(idx + 1);
            });
        }

        updateChannelDropdown(channelCounts);
        updateCounterUI(visibleCount, videoNodes.length, visibleDurationSec);
        updateSelectionButtonsUI(anyRemovable);
    }

    function scheduleFilterUpdate(delay = 80) {
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(() => {
            applyFiltersAndSort();
        }, delay);
    }

    // =========================================================================
    // 9. AUTO-LOADER ("⚡ Load All Videos" with scroll-pulsing against filter stalls)
    // =========================================================================
    async function toggleAutoLoader() {
        const btn = document.getElementById('ytwl-autoload-btn');
        if (state.autoLoading) {
            state.autoLoading = false;
            if (btn) {
                btn.classList.remove('active');
                btn.textContent = '⚡ Load All Videos';
            }
            return;
        }

        state.autoLoading = true;
        if (btn) btn.classList.add('active');

        let stallRounds = 0;
        const initialContents = getPlaylistContentsContainer();
        let lastCount = getAllVideoElements(initialContents).length;

        while (state.autoLoading && isPlaylistPage()) {
            const contents = getPlaylistContentsContainer();
            const continuation = contents
                ? contents.querySelector(CONTINUATION_SELECTOR)
                : document.querySelector(CONTINUATION_SELECTOR);

            const currentCount = getAllVideoElements(contents).length;

            if (btn) {
                btn.textContent = `⏳ Loading... (${currentCount} videos – Click to stop)`;
            }

            if (!continuation) {
                break;
            }

            continuation.scrollIntoView({ behavior: 'instant', block: 'center' });
            window.scrollBy(0, -180);
            await new Promise(r => setTimeout(r, 80));
            continuation.scrollIntoView({ behavior: 'instant', block: 'end' });
            window.scrollBy(0, 400);

            await new Promise(r => setTimeout(r, 650));

            const newCount = getAllVideoElements(contents).length;

            if (newCount > lastCount) {
                lastCount = newCount;
                stallRounds = 0;
                applyFiltersAndSort();
            } else {
                stallRounds++;
                if (stallRounds >= 9) {
                    break;
                }
            }
        }

        state.autoLoading = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        applyFiltersAndSort();

        if (btn) {
            btn.classList.remove('active');
            const totalLoaded = getAllVideoElements().length;
            btn.textContent = `✅ All Loaded (${totalLoaded})`;
            setTimeout(() => {
                if (!state.autoLoading && btn.isConnected) {
                    btn.textContent = '⚡ Load All Videos';
                }
            }, 4000);
        }
    }

    // =========================================================================
    // 10. BULK MANAGEMENT (Remove + Copy to Watch Later)
    // =========================================================================
    function isVideoRowVisible(videoEl, contents) {
        const rowEl = getSortableRow(videoEl, contents);
        return (!rowEl || rowEl.style.display !== 'none') && videoEl.style.display !== 'none';
    }

    function selectAllVisibleVideos() {
        const contents = getPlaylistContentsContainer();
        if (!contents) return;
        const visibleVideos = getAllVideoElements(contents)
            .filter(v => isVideoRowVisible(v, contents));

        const allSelectedAlready = visibleVideos.length > 0 && visibleVideos.every(v => {
            const m = extractVideoMeta(v);
            return m.videoId && state.selectedIds.has(m.videoId);
        });

        for (const v of visibleVideos) {
            const m = extractVideoMeta(v);
            if (!m.videoId) continue;
            if (allSelectedAlready) {
                state.selectedIds.delete(m.videoId);
            } else {
                state.selectedIds.add(m.videoId);
            }
            const cb = v.querySelector('.ytwl-item-checkbox');
            if (cb) cb.checked = state.selectedIds.has(m.videoId);
        }
        updateSelectionButtonsUI();
    }

    async function bulkRemoveVideos(targetVideos, labelText) {
        if (state.bulkWorking) {
            state.bulkWorking = false;
            return;
        }
        if (!targetVideos.length) return;

        const listId = getCurrentListId();
        const listName = listId === 'LL' ? 'Liked Videos' : 'this playlist';
        const confirmed = window.confirm(
            `Are you sure you want to remove ${targetVideos.length} video(s) (${labelText}) from ${listName}?`
        );
        if (!confirmed) return;

        state.bulkWorking = true;
        const bulkBtn = document.getElementById('ytwl-bulk-delete-btn');
        let removed = 0;

        for (const videoEl of targetVideos) {
            if (!state.bulkWorking || !isPlaylistPage()) break;
            if (bulkBtn) {
                bulkBtn.disabled = false;
                bulkBtn.textContent = `⏳ Removing ${removed + 1}/${targetVideos.length} (Stop)`;
            }
            await removeSingleVideo(videoEl);
            removed++;
            await new Promise(r => setTimeout(r, 220));
        }

        state.bulkWorking = false;
        applyFiltersAndSort();
    }

    async function bulkAddSelectedToWatchLater() {
        if (state.bulkWorking) {
            state.bulkWorking = false;
            return;
        }
        const contents = getPlaylistContentsContainer();
        if (!contents) return;

        const targets = getAllVideoElements(contents)
            .filter(v => {
                const m = extractVideoMeta(v);
                return m.videoId && state.selectedIds.has(m.videoId);
            });

        if (!targets.length) return;

        state.bulkWorking = true;
        const addBtn = document.getElementById('ytwl-bulk-addwl-btn');
        let added = 0;

        for (const videoEl of targets) {
            if (!state.bulkWorking || !isPlaylistPage()) break;
            const m = extractVideoMeta(videoEl);
            if (addBtn) {
                addBtn.disabled = false;
                addBtn.textContent = `⏳ Adding ${added + 1}/${targets.length}...`;
            }
            await addVideoToWatchLater(videoEl, m.videoId);
            added++;
            await new Promise(r => setTimeout(r, 180));
        }

        state.bulkWorking = false;
        if (addBtn) {
            addBtn.textContent = `✅ Added ${added} to Watch Later!`;
            setTimeout(() => updateSelectionButtonsUI(), 3000);
        }
    }

    function updateSelectionButtonsUI(anyRemovable) {
        const count = state.selectedIds.size;
        const listId = getCurrentListId();

        const typeBadge = document.getElementById('ytwl-playlist-type-badge');
        if (typeBadge) {
            typeBadge.textContent = getPlaylistTypeLabel(listId);
        }

        const bulkDeleteBtn = document.getElementById('ytwl-bulk-delete-btn');
        if (bulkDeleteBtn && !state.bulkWorking) {
            if (anyRemovable !== undefined) {
                bulkDeleteBtn.style.display = anyRemovable ? '' : 'none';
            }
            bulkDeleteBtn.disabled = count === 0;
            bulkDeleteBtn.textContent = count > 0
                ? `🗑️ Remove Selected (${count})`
                : '🗑️ Remove Selected (0)';
        }

        const cleanWatchedBtn = document.getElementById('ytwl-clean-watched-btn');
        if (cleanWatchedBtn && anyRemovable !== undefined) {
            cleanWatchedBtn.style.display = anyRemovable ? '' : 'none';
        }

        const bulkAddWlBtn = document.getElementById('ytwl-bulk-addwl-btn');
        if (bulkAddWlBtn && !state.bulkWorking) {
            bulkAddWlBtn.style.display = listId !== 'WL' ? '' : 'none';
            bulkAddWlBtn.disabled = count === 0;
            bulkAddWlBtn.textContent = count > 0
                ? `➕ Add Selected to Watch Later (${count})`
                : '➕ Add Selected to Watch Later (0)';
        }
    }

    function updateCounterUI(visibleCount, totalCount, visibleDurationSec) {
        const counterEl = document.getElementById('ytwl-counter-text');
        if (counterEl) {
            counterEl.textContent = `Showing ${visibleCount} of ${totalCount} loaded videos`;
        }
        const durEl = document.getElementById('ytwl-duration-text');
        if (durEl) {
            durEl.textContent = `⏱️ Filtered Duration: ${formatSecondsHuman(visibleDurationSec)}`;
        }
    }

    function resetAllFilters() {
        state.search = '';
        state.channel = 'ALL';
        state.durationQuick = 'ALL';
        state.maxMinutes = '';
        state.status = 'ALL';
        state.hideShorts = false;
        state.sortBy = 'DEFAULT';

        const searchIn = document.getElementById('ytwl-search-input');
        if (searchIn) searchIn.value = '';
        const chanSel = document.getElementById('ytwl-channel-select');
        if (chanSel) chanSel.value = 'ALL';
        const maxMinIn = document.getElementById('ytwl-maxmin-input');
        if (maxMinIn) maxMinIn.value = '';
        const statusSel = document.getElementById('ytwl-status-select');
        if (statusSel) statusSel.value = 'ALL';
        const sortSel = document.getElementById('ytwl-sort-select');
        if (sortSel) sortSel.value = 'DEFAULT';
        const shortsBtn = document.getElementById('ytwl-shorts-btn');
        if (shortsBtn) shortsBtn.classList.remove('active');

        document.querySelectorAll('.ytwl-dur-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.dur === 'ALL');
        });

        applyFiltersAndSort();
    }

    // =========================================================================
    // 11. BUILD FILTER BAR UI (100% createElement)
    // =========================================================================
    function buildFilterBar() {
        const listId = getCurrentListId();

        // 1. Live Text Search
        const searchInput = el('input', {
            id: 'ytwl-search-input',
            type: 'search',
            className: 'ytwl-input ytwl-input-search',
            placeholder: '🔍 Search title or channel...',
            value: state.search,
            onInput: (e) => {
                state.search = e.target.value;
                scheduleFilterUpdate(60);
            }
        });

        // 2. Channel Quickfilter Dropdown
        const channelSelect = el('select', {
            id: 'ytwl-channel-select',
            className: 'ytwl-select',
            title: 'Filter by channel',
            onChange: (e) => {
                state.channel = e.target.value;
                applyFiltersAndSort();
            }
        }, [
            el('option', { value: 'ALL', textContent: 'All Channels (0)' })
        ]);

        // 3. Watch Status Filter Dropdown
        const statusSelect = el('select', {
            id: 'ytwl-status-select',
            className: 'ytwl-select',
            title: 'Filter by watch status',
            onChange: (e) => {
                state.status = e.target.value;
                applyFiltersAndSort();
            }
        }, [
            el('option', { value: 'ALL', textContent: 'Status: All' }),
            el('option', { value: 'UNWATCHED', textContent: '🔵 Unwatched (0%)' }),
            el('option', { value: 'IN_PROGRESS', textContent: '🟡 In Progress (1–79%)' }),
            el('option', { value: 'ALMOST_DONE', textContent: '🟢 Almost Done / Watched (≥ 80%)' }),
            el('option', { value: 'COMPLETED', textContent: '✅ Completed (100%)' }),
            el('option', { value: 'ANY_STARTED', textContent: '▶️ Any Started (> 0%)' })
        ]);

        // 4. Sort Dropdown
        const sortSelect = el('select', {
            id: 'ytwl-sort-select',
            className: 'ytwl-select',
            title: 'Sort loaded videos',
            onChange: (e) => {
                state.sortBy = e.target.value;
                applyFiltersAndSort();
            }
        }, [
            el('option', { value: 'DEFAULT', textContent: 'Sort: Default Order' }),
            el('option', { value: 'SHORTEST', textContent: '⏱️ Shortest First' }),
            el('option', { value: 'LONGEST', textContent: '⏳ Longest First' }),
            el('option', { value: 'PROGRESS_DESC', textContent: '📊 Most Watched First (%)' }),
            el('option', { value: 'CHANNEL_ASC', textContent: '🔤 Channel (A–Z)' }),
            el('option', { value: 'TITLE_ASC', textContent: '🔤 Title (A–Z)' }),
            el('option', { value: 'REVERSE', textContent: '🔄 Reverse Order' })
        ]);

        // 5. Duration Quick Buttons + Max Minutes Input
        const durOptions = [
            { id: 'ALL', label: 'All' },
            { id: 'LT10', label: '< 10m' },
            { id: '10TO30', label: '10–30m' },
            { id: 'GT30', label: '> 30m' }
        ];

        const maxMinInput = el('input', {
            id: 'ytwl-maxmin-input',
            type: 'number',
            min: '1',
            step: '1',
            className: 'ytwl-input ytwl-input-num',
            placeholder: 'Max min',
            title: 'Maximum video duration in minutes',
            value: state.maxMinutes,
            onInput: (e) => {
                state.maxMinutes = e.target.value;
                if (state.maxMinutes !== '') {
                    state.durationQuick = 'ALL';
                    document.querySelectorAll('.ytwl-dur-btn').forEach(b => {
                        b.classList.toggle('active', b.dataset.dur === 'ALL');
                    });
                }
                scheduleFilterUpdate(80);
            }
        });

        const durButtons = durOptions.map(opt => el('button', {
            type: 'button',
            className: `ytwl-btn ytwl-dur-btn ${state.durationQuick === opt.id ? 'active' : ''}`,
            dataset: { dur: opt.id },
            textContent: opt.label,
            onClick: () => {
                state.durationQuick = opt.id;
                if (opt.id !== 'ALL') {
                    state.maxMinutes = '';
                    maxMinInput.value = '';
                }
                document.querySelectorAll('.ytwl-dur-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.dur === opt.id);
                });
                applyFiltersAndSort();
            }
        }));

        const shortsToggleBtn = el('button', {
            id: 'ytwl-shorts-btn',
            type: 'button',
            className: `ytwl-btn ${state.hideShorts ? 'active' : ''}`,
            title: 'Hide YouTube Shorts',
            textContent: '🚫 Hide Shorts',
            onClick: () => {
                state.hideShorts = !state.hideShorts;
                shortsToggleBtn.classList.toggle('active', state.hideShorts);
                applyFiltersAndSort();
            }
        });

        // 6. Auto-Loader & Random Video
        const autoLoadBtn = el('button', {
            id: 'ytwl-autoload-btn',
            type: 'button',
            className: 'ytwl-btn ytwl-btn-accent',
            title: 'Automatically scrolls down until all videos in the playlist are loaded into the DOM',
            textContent: '⚡ Load All Videos',
            onClick: toggleAutoLoader
        });

        const randomBtn = el('button', {
            type: 'button',
            className: 'ytwl-btn',
            title: 'Open a random video from the currently filtered results',
            textContent: '🎲 Random',
            onClick: () => {
                const contents = getPlaylistContentsContainer();
                if (!contents) return;
                const visible = getAllVideoElements(contents)
                    .filter(v => isVideoRowVisible(v, contents));
                if (!visible.length) return;
                const pick = visible[Math.floor(Math.random() * visible.length)];
                const link = pick.querySelector('a#video-title, a.ytLockupMetadataViewModelTitle, a#thumbnail');
                if (link) link.click();
            }
        });

        // 7. Management Actions (Select / Add to Watch Later / Remove / Reset)
        const selectVisibleBtn = el('button', {
            type: 'button',
            className: 'ytwl-btn',
            title: 'Select or deselect all currently visible (filtered) videos',
            textContent: '☑️ Select Visible',
            onClick: selectAllVisibleVideos
        });

        const bulkAddWlBtn = el('button', {
            id: 'ytwl-bulk-addwl-btn',
            type: 'button',
            className: 'ytwl-btn ytwl-btn-success',
            style: { display: listId !== 'WL' ? '' : 'none' },
            disabled: true,
            title: 'Add all selected videos to your Watch Later playlist',
            textContent: '➕ Add Selected to Watch Later (0)',
            onClick: bulkAddSelectedToWatchLater
        });

        const bulkDeleteSelectedBtn = el('button', {
            id: 'ytwl-bulk-delete-btn',
            type: 'button',
            className: 'ytwl-btn ytwl-btn-danger',
            disabled: true,
            textContent: '🗑️ Remove Selected (0)',
            onClick: () => {
                const contents = getPlaylistContentsContainer();
                if (!contents) return;
                const targets = getAllVideoElements(contents)
                    .filter(v => {
                        const m = extractVideoMeta(v);
                        return m.videoId && state.selectedIds.has(m.videoId);
                    });
                bulkRemoveVideos(targets, 'selected');
            }
        });

        const cleanWatchedBtn = el('button', {
            id: 'ytwl-clean-watched-btn',
            type: 'button',
            className: 'ytwl-btn ytwl-btn-danger',
            title: 'Remove all loaded videos watched at least 80%',
            textContent: '🧹 Remove Watched (≥ 80%)',
            onClick: () => {
                const contents = getPlaylistContentsContainer();
                if (!contents) return;
                const targets = getAllVideoElements(contents)
                    .filter(v => extractVideoMeta(v).progressPct >= 80);
                if (!targets.length) {
                    window.alert('No loaded videos with ≥ 80% watch progress found.');
                    return;
                }
                bulkRemoveVideos(targets, '≥ 80% watched');
            }
        });

        const resetBtn = el('button', {
            type: 'button',
            className: 'ytwl-btn',
            title: 'Reset all filters and sorting',
            textContent: '↺ Reset',
            onClick: resetAllFilters
        });

        // Row 1: Search, Channel, Status, Sort, Auto-Loader
        const row1 = el('div', { className: 'ytwl-row' }, [
            searchInput,
            el('div', { className: 'ytwl-group' }, [
                el('span', { className: 'ytwl-label', textContent: 'Channel' }),
                channelSelect
            ]),
            el('div', { className: 'ytwl-group' }, [
                statusSelect
            ]),
            el('div', { className: 'ytwl-group' }, [
                sortSelect
            ]),
            autoLoadBtn
        ]);

        // Row 2: Duration Filter + Shorts + Management Actions
        const row2 = el('div', { className: 'ytwl-row' }, [
            el('div', { className: 'ytwl-group' }, [
                el('span', { className: 'ytwl-label', textContent: 'Duration' }),
                ...durButtons,
                maxMinInput
            ]),
            shortsToggleBtn,
            randomBtn,
            selectVisibleBtn,
            bulkAddWlBtn,
            bulkDeleteSelectedBtn,
            cleanWatchedBtn
        ]);

        // Row 3: Playlist Type, Live Counter, Total Duration & Reset
        const row3 = el('div', { className: 'ytwl-row-between' }, [
            el('div', { className: 'ytwl-stats' }, [
                el('span', { id: 'ytwl-playlist-type-badge', className: 'ytwl-playlist-type-badge', textContent: getPlaylistTypeLabel(listId) }),
                el('span', { id: 'ytwl-counter-text', className: 'ytwl-stat-badge', textContent: 'Showing 0 of 0 loaded videos' }),
                el('span', { id: 'ytwl-duration-text', className: 'ytwl-stat-badge', textContent: '⏱️ Filtered Duration: 0 min' })
            ]),
            resetBtn
        ]);

        return el('section', { id: PANEL_ID }, [row1, row2, row3]);
    }

    // =========================================================================
    // 12. BONUS: DIRECT BUTTON IN MINI-PLAYLIST ON /watch?v=...&list=...
    // =========================================================================
    function ensureWatchPagePlaylistButton() {
        if (!isWatchPageWithPlaylist()) return;
        injectStyles();

        const listId = getCurrentListId();
        if (!listId) return;

        const playlistPanelHeader = document.querySelector(
            'ytd-playlist-panel-renderer:not([hidden]) #header-contents, #secondary ytd-playlist-panel-renderer #header-contents'
        );
        if (!playlistPanelHeader) return;

        let btn = document.getElementById(WATCH_BTN_ID);
        const targetUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;

        if (!btn) {
            btn = el('a', {
                id: WATCH_BTN_ID,
                href: targetUrl,
                className: 'ytwl-btn ytwl-btn-accent',
                title: 'Open this playlist in the full Playlist Manager & Filter view',
                textContent: '📋 Open & Filter in Playlist Manager'
            });
            playlistPanelHeader.appendChild(btn);
        } else {
            btn.setAttribute('href', targetUrl);
            if (btn.parentElement !== playlistPanelHeader) {
                playlistPanelHeader.appendChild(btn);
            }
        }
    }

    // =========================================================================
    // 13. INITIALIZATION, MUTATION OBSERVER & SPA LIFECYCLE
    // =========================================================================
    function attachPlaylistObserver(contentsContainer) {
        if (observedContentsNode === contentsContainer && playlistObserver) {
            return;
        }
        if (playlistObserver) {
            playlistObserver.disconnect();
        }
        observedContentsNode = contentsContainer;
        playlistObserver = new MutationObserver(() => {
            scheduleFilterUpdate(80);
        });

        playlistObserver.observe(contentsContainer, {
            childList: true,
            subtree: false
        });
    }

    function ensureManagerMounted() {
        if (isWatchPageWithPlaylist()) {
            ensureWatchPagePlaylistButton();
            return;
        }

        if (!isPlaylistPage()) {
            state.autoLoading = false;
            return;
        }

        injectStyles();

        const active = getActivePlaylistContainers();
        if (!active) return;
        const { host, contents } = active;

        const urlPlaylistId = getCurrentListId();
        if (state.currentPlaylistId !== urlPlaylistId) {
            state.currentPlaylistId = urlPlaylistId;
            state.playlistEpoch++;
            state.selectedIds.clear();
            state.autoLoading = false;
            originalIndexCounter = 0;
            state.channel = 'ALL';
            const chanSel = document.getElementById('ytwl-channel-select');
            if (chanSel) chanSel.value = 'ALL';
        }

        let panel = document.getElementById(PANEL_ID);
        if (!panel) {
            panel = buildFilterBar();
        }

        if (panel.parentElement !== host || panel.nextElementSibling !== contents) {
            host.insertBefore(panel, contents);
        }

        attachPlaylistObserver(contents);
        applyFiltersAndSort();
    }

    // YouTube SPA Events + Fallback Interval
    window.addEventListener('yt-navigate-finish', () => {
        setTimeout(ensureManagerMounted, 150);
        setTimeout(ensureManagerMounted, 600);
    });
    window.addEventListener('yt-page-data-updated', () => {
        setTimeout(ensureManagerMounted, 180);
    });
    window.addEventListener('popstate', () => {
        setTimeout(ensureManagerMounted, 200);
    });

    // Periodic lightweight check (verifies every 800ms that the panel is mounted in the currently visible container)
    setInterval(() => {
        if (isWatchPageWithPlaylist()) {
            ensureWatchPagePlaylistButton();
            return;
        }
        if (!isPlaylistPage()) return;
        const panel = document.getElementById(PANEL_ID);
        const active = getActivePlaylistContainers();
        if (active && (!panel || panel.parentElement !== active.host || !isNodeActuallyVisible(panel))) {
            ensureManagerMounted();
        }
    }, 800);

    // Initial startup
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureManagerMounted);
    } else {
        ensureManagerMounted();
    }
})();
