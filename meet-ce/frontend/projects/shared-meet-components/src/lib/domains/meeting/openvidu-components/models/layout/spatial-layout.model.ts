import { LayoutBox } from './layout-types.model';

/**
 * @internal
 * One element of the layout container, as the spatial layout sees it.
 */
export interface SpatialLayoutItem {
	/** The local user's camera tile. */
	isLocalCamera: boolean;
	/** A screen share (local or remote). */
	isScreen: boolean;
	/** Pinned by the user. */
	isPinned: boolean;
	/** Width / height of the video, used for a screen share. */
	ratio: number;
}

const GAP = 8;
const TILE_RATIO = 16 / 9;
/** The local camera is shown smaller than the others: nobody needs to see themselves big. */
const SELF_SCALE = 0.6;
/** A screen share keeps at least this share of the width it would have on its own (row layout). */
const MIN_SCREEN_SCALE = 0.5;
/** Columns beside a screen share are at least this wide (else the people go in a row below it) and at most this. */
const MIN_COLUMN = 160;
const MAX_COLUMN = 480;

/**
 * @internal
 *
 * Layout used while spatial audio is on. Everyone sits next to each other in one row, as around a table seen
 * from the other side of the screen, so each voice comes from a direction on the horizontal plane (see
 * `SpatialAudioService`). The tiles are as large as the row allows.
 *
 * - Without a screen share, the row is centred and the local camera (smaller) sits in its middle.
 * - With a screen share (or a pinned remote camera), that is centred and as large as it can be; the others sit
 *   in columns to its left and right, the local camera at the bottom of the right column. In a window too narrow
 *   for columns, the others sit in a row below it and the local camera in the bottom-right corner.
 *
 * Returns one box per item, in the same order.
 */
export function calculateSpatialLayout(width: number, height: number, items: SpatialLayoutItem[]): LayoutBox[] {
	const screens = items.filter((item) => item.isScreen);
	const self = items.find((item) => item.isLocalCamera && !item.isScreen);
	const focus =
		screens.find((item) => item.isPinned) ??
		screens[0] ??
		items.find((item) => item.isPinned && !item.isLocalCamera) ??
		undefined;
	const others = items.filter((item) => item !== focus && item !== self);
	const placed = new Map<SpatialLayoutItem, LayoutBox>();

	if (focus) {
		const layout = sideColumnsLayout(width, height, focus.ratio, others.length, !!self) ?? focusLayout(width, height, focus.ratio, others.length, !!self);
		layout.forEach((box, i) => {
			const item = i === 0 ? focus : i === 1 ? self : others[i - 2];
			if (item && box) placed.set(item, box);
		});
	} else {
		// The local camera in the middle of the row (the left half gets the extra person).
		const row = [...others];
		if (self) row.splice(Math.ceil(others.length / 2), 0, self);
		const boxes = rowLayout(row.map((item) => (item === self ? SELF_SCALE : 1)), height / 2, width, height);
		row.forEach((item, i) => placed.set(item, boxes[i]));
	}

	const fallback = box(width / 2, height / 2, 0, 0);
	return items.map((item) => placed.get(item) ?? fallback);
}

/**
 * Screen share in the middle at (nearly) the size it would have alone, the others in columns to its left and
 * right (the left one takes the extra person), the local camera (smaller) at the bottom of the right column.
 * Returns the boxes of the screen share, the local camera (if any) and the others, in that order, or undefined
 * when the window is too narrow for columns of {@link MIN_COLUMN}.
 */
function sideColumnsLayout(width: number, height: number, ratio: number, count: number, withSelf: boolean): (LayoutBox | undefined)[] | undefined {
	const inner = { w: width - 2 * GAP, h: height - 2 * GAP };
	const r = ratio > 0 && isFinite(ratio) ? ratio : TILE_RATIO;
	if (count === 0 && !withSelf) return [box(width / 2, height / 2, fit(r, inner.w, inner.h).w, fit(r, inner.w, inner.h).h)];

	// The screen share keeps its full size if that leaves columns of MIN_COLUMN; else it shrinks to make room.
	let screen = fit(r, inner.w, inner.h);
	let column = (inner.w - screen.w) / 2 - GAP;
	if (column < MIN_COLUMN) {
		column = MIN_COLUMN;
		screen = fit(r, inner.w - 2 * (column + GAP), inner.h);
		if (screen.w < inner.w * 0.5) return undefined;
	}
	column = Math.min(column, MAX_COLUMN);

	const left = Math.ceil(count / 2);
	const right = count - left;
	// Tiles as wide as the column, unless the column's height doesn't fit them all.
	const stackWidth = (n: number, h: number) => (n === 0 ? column : Math.min(column, ((h - (n - 1) * GAP) / n) * TILE_RATIO));
	const selfShare = withSelf ? SELF_SCALE : 0;
	const tileWidth = Math.min(
		stackWidth(left, inner.h),
		// The right column holds `right` tiles and the smaller local camera.
		right + selfShare > 0 ? Math.min(column, ((inner.h - right * GAP) / (right + selfShare)) * TILE_RATIO) : column
	);
	const tileHeight = tileWidth / TILE_RATIO;
	const selfWidth = Math.max(80, tileWidth * SELF_SCALE);
	const selfBox = withSelf ? corner(width, height, selfWidth) : undefined;

	// Each column's tiles spread evenly over its height (the right one above the local camera).
	const stack = (n: number, cx: number, bottom: number) =>
		Array.from({ length: n }, (_, i) => box(cx, GAP + ((bottom - GAP) * (i + 0.5)) / n, tileWidth, tileHeight));
	const rightBottom = selfBox ? selfBox.top - GAP : height - GAP;
	const boxes = [
		...stack(left, GAP + column / 2, height - GAP),
		...stack(right, width - GAP - column / 2, rightBottom)
	];
	return [box(width / 2, height / 2, screen.w, screen.h), selfBox, ...boxes];
}

/**
 * Screen share at the top, the others in a row below it, the local camera in the bottom-right corner. Returns
 * the boxes of the screen share, the local camera (if any) and the others, in that order. The row gets the
 * largest height that leaves the screen share {@link MIN_SCREEN_SCALE} of its width.
 */
function focusLayout(width: number, height: number, ratio: number, count: number, withSelf: boolean): (LayoutBox | undefined)[] {
	const inner = { w: width - 2 * GAP, h: height - 2 * GAP };
	const solo = fit(ratio, inner.w, inner.h);
	const r = ratio > 0 && isFinite(ratio) ? ratio : TILE_RATIO;

	if (count === 0) {
		// Just the screen share and the local camera: the screen share beside or above the corner, whichever is larger.
		const selfWidth = Math.min(260, width * 0.2);
		const selfBox = withSelf ? corner(width, height, selfWidth) : undefined;
		const beside = fit(r, inner.w - 2 * (selfWidth + GAP), inner.h);
		const above = fit(r, inner.w, inner.h - (selfWidth / TILE_RATIO + GAP));
		const screen = !withSelf ? solo : beside.w > above.w ? beside : above;
		const screenTop = !withSelf || beside.w > above.w ? GAP + (inner.h - screen.h) / 2 : GAP;
		return [{ left: (width - screen.w) / 2, top: screenTop, width: screen.w, height: screen.h }, selfBox];
	}

	// From the tallest row down: the first that leaves the screen share enough room wins.
	for (let rowHeight = inner.h / 2; rowHeight > 20; rowHeight *= 0.97) {
		// The row is centred on the screen, clear of the local camera in the corner (which is a bit smaller than
		// the tiles, whose width in turn depends on the room it leaves).
		let selfWidth = withSelf ? rowHeight * SELF_SCALE * TILE_RATIO : 0;
		let tileWidth = 0;
		for (let i = 0; i < 3; i++) {
			const rowWidth = width - 2 * (selfWidth + 2 * GAP);
			tileWidth = Math.min(rowHeight * TILE_RATIO, (rowWidth - (count - 1) * GAP) / count);
			if (withSelf) selfWidth = Math.max(80, tileWidth * SELF_SCALE);
		}
		const tileHeight = tileWidth / TILE_RATIO;
		const screen = fit(r, inner.w, inner.h - Math.max(tileHeight, selfWidth / TILE_RATIO) - GAP);
		if (screen.w < solo.w * MIN_SCREEN_SCALE && rowHeight * 0.97 > 20) continue;

		const rowTop = height - GAP - tileHeight;
		const boxes = rowLayout(new Array(count).fill(1), rowTop + tileHeight / 2, width, height, tileWidth);
		// The screen share centred in the room above the row.
		const screenBox = { left: (width - screen.w) / 2, top: GAP + (rowTop - 2 * GAP - screen.h) / 2, width: screen.w, height: screen.h };
		return [screenBox, withSelf ? corner(width, height, selfWidth) : undefined, ...boxes];
	}
	return [box(width / 2, height / 2, solo.w, solo.h)];
}

/**
 * One horizontally centred row of 16:9 tiles (`scales`: size relative to the others), vertically centred on
 * `centreY`, as large as the container allows or with the given tile width.
 */
function rowLayout(scales: number[], centreY: number, width: number, height: number, tileWidth?: number): LayoutBox[] {
	const total = scales.reduce((sum, s) => sum + s, 0);
	const gaps = (scales.length + 1) * GAP;
	const w = tileWidth ?? Math.min((width - gaps) / total, (height - 2 * GAP) * TILE_RATIO);
	const rowWidth = w * total + (scales.length - 1) * GAP;
	let x = (width - rowWidth) / 2;
	return scales.map((scale) => {
		const b = box(x + (w * scale) / 2, centreY, w * scale, (w * scale) / TILE_RATIO);
		x += w * scale + GAP;
		return b;
	});
}

function corner(width: number, height: number, w: number): LayoutBox {
	const h = w / TILE_RATIO;
	return { left: width - GAP - w, top: height - GAP - h, width: w, height: h };
}

function fit(ratio: number, maxW: number, maxH: number): { w: number; h: number } {
	const r = ratio > 0 && isFinite(ratio) ? ratio : TILE_RATIO;
	const w = Math.max(0, Math.min(maxW, maxH * r));
	return { w, h: w / r };
}

function box(cx: number, cy: number, w: number, h: number): LayoutBox {
	return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}
