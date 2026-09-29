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
	/** Width / height of the video, used for the centre tile. */
	ratio: number;
}

/** @internal The result of {@link calculateSpatialLayout}. */
export interface SpatialLayout {
	/** One box per item, in the same order. */
	boxes: LayoutBox[];
	/** Where the listener sits (centre of the local camera, or of the screen share): voices come from around it. */
	listener: { x: number; y: number };
}

const GAP = 8;
const TILE_RATIO = 16 / 9;
const MIN_TILE_WIDTH = 80;
/** Each step of the search for the largest tile size. */
const SHRINK = 0.97;
/** The local camera is shown smaller than the others: nobody needs to see themselves big. */
const SELF_SCALE = 0.6;
/** A screen share keeps at least this share of the width it would have on its own. */
const MIN_SCREEN_SCALE = 0.5;
/** Up to this many others may sit above and beside the local camera instead of all around it. */
const MAX_ARC = 4;

/**
 * @internal
 *
 * Layout used while spatial audio is on: everyone sits around the listener, so each voice comes from where the
 * person is on screen (see `SpatialAudioService`), and the videos of the others are as large as they can be.
 *
 * - Without a screen share, the local camera is the listener, in the middle of a ring of the others. With up
 *   to four others it may instead sit at the bottom centre with them above and beside it (left to right),
 *   whichever gives them larger tiles.
 * - With a screen share (or a pinned remote camera), that is in the middle and the listener's focus. The others
 *   are stacked in a left and a right column as wide as the screen share allows, and the local camera sits in
 *   the bottom-right corner below the right column.
 */
export function calculateSpatialLayout(width: number, height: number, items: SpatialLayoutItem[]): SpatialLayout {
	const screens = items.filter((item) => item.isScreen);
	const localCamera = items.find((item) => item.isLocalCamera && !item.isScreen);
	const focus =
		screens.find((item) => item.isPinned) ??
		screens[0] ??
		items.find((item) => item.isPinned && !item.isLocalCamera) ??
		undefined;
	const others = items.filter((item) => item !== focus && item !== localCamera);
	const inner: LayoutBox = { left: GAP, top: GAP, width: width - 2 * GAP, height: height - 2 * GAP };

	const placed = new Map<SpatialLayoutItem, LayoutBox>();
	let listenerBox: LayoutBox | undefined;

	if (focus) {
		const { focusBox, selfBox, boxes } = columnsLayout(width, height, inner, focus.ratio, others.length, !!localCamera);
		placed.set(focus, focusBox);
		if (localCamera && selfBox) placed.set(localCamera, selfBox);
		others.forEach((item, i) => placed.set(item, boxes[i]));
		listenerBox = focusBox;
	} else if (others.length === 0) {
		if (localCamera) placed.set(localCamera, centred(localCamera.ratio, inner));
		listenerBox = localCamera && placed.get(localCamera);
	} else {
		const arrangements = [ringLayout(width, height, others.length, localCamera, false)];
		if (others.length <= MAX_ARC) arrangements.push(ringLayout(width, height, others.length, localCamera, true));
		const best = arrangements.sort((a, b) => b.tileWidth - a.tileWidth)[0];
		if (localCamera && best.selfBox) placed.set(localCamera, best.selfBox);
		others.forEach((item, i) => placed.set(item, best.boxes[i]));
		listenerBox = best.selfBox;
	}

	const fallback = box(width / 2, height / 2, MIN_TILE_WIDTH, MIN_TILE_WIDTH / TILE_RATIO);
	return {
		boxes: items.map((item) => placed.get(item) ?? fallback),
		listener: listenerBox
			? { x: listenerBox.left + listenerBox.width / 2, y: listenerBox.top + listenerBox.height / 2 }
			: { x: width / 2, y: height / 2 }
	};
}

/**
 * Screen share in the middle, the others in a left and a right column (in order: down the left column, then
 * down the right one), the local camera below the right column. The columns are as wide as the screen share
 * allows (it keeps {@link MIN_SCREEN_SCALE} of its width) and the stacked tiles fit in.
 */
function columnsLayout(
	width: number,
	height: number,
	inner: LayoutBox,
	focusRatio: number,
	count: number,
	withSelf: boolean
): { focusBox: LayoutBox; selfBox?: LayoutBox; boxes: LayoutBox[] } {
	const fullScreen = fit(focusRatio, inner.width, inner.height);

	// Widest columns the screen share leaves room for, with the split between them that allows the widest.
	// The left column may take more people, since the right one shares its height with the local camera.
	const byScreen = (inner.width - 2 * GAP - fullScreen.w * MIN_SCREEN_SCALE) / 2;
	let columnWidth = 0;
	let left = 0;
	for (let l = Math.ceil(count / 2); l <= count; l++) {
		const w = Math.min(byScreen, width * 0.4, stackWidth(l, inner.height), rightColumnWidth(count - l, inner.height, withSelf));
		if (w > columnWidth + 0.5) [columnWidth, left] = [w, l];
	}
	columnWidth = Math.max(MIN_TILE_WIDTH, columnWidth);
	const right = count - left;
	const tileHeight = columnWidth / TILE_RATIO;

	const selfWidth = Math.max(MIN_TILE_WIDTH, Math.min(columnWidth, 260) * (count > 0 ? SELF_SCALE : 1));
	const selfHeight = selfWidth / TILE_RATIO;
	const selfBox = withSelf
		? { left: width - GAP - selfWidth, top: height - GAP - selfHeight, width: selfWidth, height: selfHeight }
		: undefined;

	// Tiles spread evenly over each column's height, so their voices are spread from front to back.
	const column = (n: number, x: number, bottom: number) =>
		Array.from({ length: n }, (_, i) => box(x, GAP + ((bottom - GAP) * (i + 0.5)) / n, columnWidth, tileHeight));
	const rightBottom = withSelf ? height - GAP - selfHeight - GAP : height - GAP;
	const boxes = [
		...column(left, GAP + columnWidth / 2, height - GAP),
		...column(right, width - GAP - columnWidth / 2, rightBottom)
	];

	// The screen share takes the middle band, or everything but the local camera's corner when alone.
	if (count === 0) {
		const area = { ...inner };
		let focusBox = centred(focusRatio, area);
		if (selfBox && overlaps(focusBox, selfBox)) focusBox = centred(focusRatio, { ...area, width: inner.width - 2 * (selfWidth + GAP), left: inner.left + selfWidth + GAP });
		return { focusBox, selfBox, boxes };
	}
	const band = columnWidth + GAP;
	const focusBox = centred(focusRatio, { left: inner.left + band, top: inner.top, width: inner.width - 2 * band, height: inner.height });
	return { focusBox, selfBox, boxes };
}

/** Widest 16:9 tiles of which `n` fit stacked in a column of the given height. */
function stackWidth(n: number, columnHeight: number): number {
	return n === 0 ? Infinity : ((columnHeight - (n - 1) * GAP) / n) * TILE_RATIO;
}

/** Like {@link stackWidth}, for the right column, which also holds the (smaller) local camera at the bottom. */
function rightColumnWidth(n: number, columnHeight: number, withSelf: boolean): number {
	if (!withSelf || n === 0) return stackWidth(n, columnHeight);
	// n tiles of height h plus the local camera of height SELF_SCALE * h, with gaps.
	return ((columnHeight - n * GAP) / (n + SELF_SCALE)) * TILE_RATIO;
}

/**
 * The others on a ring around the local camera: in the middle of the container, or (`arc`) at its bottom
 * centre with the others above and beside it. The tiles get the largest size at which nothing overlaps.
 */
function ringLayout(
	width: number,
	height: number,
	count: number,
	self: SpatialLayoutItem | undefined,
	arc: boolean
): { tileWidth: number; selfBox?: LayoutBox; boxes: LayoutBox[] } {
	const angles = ringAngles(count, arc);
	let last: { tileWidth: number; selfBox?: LayoutBox; boxes: LayoutBox[] } | undefined;

	for (let tileWidth = Math.min(width - 2 * GAP, (height - 2 * GAP) * TILE_RATIO); tileWidth >= MIN_TILE_WIDTH; tileWidth *= SHRINK) {
		const tileHeight = tileWidth / TILE_RATIO;
		const selfWidth = Math.max(MIN_TILE_WIDTH, tileWidth * SELF_SCALE);
		const selfHeight = selfWidth / (self?.ratio || TILE_RATIO);
		const cx = width / 2;
		const cy = arc ? height - GAP - selfHeight / 2 : height / 2;
		const selfBox = self ? box(cx, cy, selfWidth, selfHeight) : undefined;

		const rx = width / 2 - tileWidth / 2 - GAP;
		const up = cy - tileHeight / 2 - GAP;
		const down = height - cy - tileHeight / 2 - GAP;
		if (rx < 0 || up < 0) continue;
		// Tiles stay inside the container (an arc's ends sit beside a low listener, not below it).
		const clampX = (x: number) => Math.min(width - GAP - tileWidth / 2, Math.max(GAP + tileWidth / 2, x));
		const clampY = (y: number) => Math.min(height - GAP - tileHeight / 2, Math.max(GAP + tileHeight / 2, y));
		const boxes = angles.map((angle) => {
			const [px, py] = superellipse(angle);
			const y = cy - py * (py > 0 ? up : Math.max(0, down));
			return box(clampX(cx + px * rx), clampY(y), tileWidth, tileHeight);
		});
		last = { tileWidth, selfBox, boxes };

		const all = selfBox ? [...boxes, selfBox] : boxes;
		if (!all.some((a, i) => all.some((b, j) => j > i && overlaps(a, b)))) return last;
	}
	// A container too small for everyone: the smallest tiles, which may overlap a little.
	const smallest = box(width / 2, height / 2, MIN_TILE_WIDTH, MIN_TILE_WIDTH / TILE_RATIO);
	return { selfBox: last?.selfBox, boxes: last?.boxes ?? angles.map(() => smallest), tileWidth: 0 };
}

/**
 * Angles (radians, 0 = right, counter-clockwise, so π/2 = top) of the ring tiles, left to right. Positions on
 * the sides are preferred: that is where the ear tells directions apart best.
 */
function ringAngles(count: number, arc: boolean): number[] {
	if (arc) {
		// Above and beside the local camera, which sits at the bottom.
		return Array.from({ length: count }, (_, i) => deg(180 - ((i + 0.5) * 180) / count));
	}
	// Full ring, symmetric around the top (just the top for one person).
	if (count === 1) return [Math.PI / 2];
	return Array.from({ length: count }, (_, i) => deg(90 + (360 * ((count - 1) / 2 - i)) / count));
}

/** A point on the unit superellipse (n = 4), which pushes diagonal positions towards the corners. */
function superellipse(angle: number): [number, number] {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return [Math.sign(c) * Math.sqrt(Math.abs(c)), Math.sign(s) * Math.sqrt(Math.abs(s))];
}

function fit(ratio: number, maxW: number, maxH: number): { w: number; h: number } {
	const r = ratio > 0 && isFinite(ratio) ? ratio : TILE_RATIO;
	const w = Math.min(maxW, maxH * r);
	return { w, h: w / r };
}

/** The largest box of the given ratio centred in `area`. */
function centred(ratio: number, area: LayoutBox): LayoutBox {
	const { w, h } = fit(ratio, area.width, area.height);
	return box(area.left + area.width / 2, area.top + area.height / 2, w, h);
}

function box(cx: number, cy: number, w: number, h: number): LayoutBox {
	return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}

function overlaps(a: LayoutBox, b: LayoutBox): boolean {
	const gap = GAP / 2;
	return (
		a.left < b.left + b.width + gap &&
		b.left < a.left + a.width + gap &&
		a.top < b.top + b.height + gap &&
		b.top < a.top + a.height + gap
	);
}

function deg(degrees: number): number {
	return (degrees * Math.PI) / 180;
}
