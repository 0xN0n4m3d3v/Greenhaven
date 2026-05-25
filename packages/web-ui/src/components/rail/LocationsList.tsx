// Locations list — extracted from App.tsx (spec 29 decomposition).
// Receives the location array + current-location id + a busy flag +
// a click-to-travel callback. Dedups aliased duplicates.
//
// Adds a `collapsed` icon-mode that renders a single Compass button
// opening a Radix popover with the same list inside.

import {motion} from 'motion/react';
import {Compass, Map} from 'lucide-react';
import {useState} from 'react';
import {MediaAsset} from '../media/MediaAsset';
import {Popover, PopoverContent, PopoverTrigger} from '../ui/popover';

interface LocationCardData {
  id: number;
  name: string;
  status: string;
  unread: number;
  visual_asset_urls?: Record<string, string> | null;
}

interface Props {
  locations: LocationCardData[];
  currentLocationId: number;
  busy: boolean;
  onOpenMap: () => void;
  collapsed?: boolean;
}

export function LocationsList({
  locations,
  currentLocationId,
  busy,
  onOpenMap,
  collapsed = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const seen = new Set<number>();
  const unique = locations.filter(l => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });

  const current =
    unique.find(location => location.id === currentLocationId) ??
    unique.find(location => location.status === 'current') ??
    unique[0];
  const exitCount = unique.filter(
    location => location.id !== currentLocationId && location.status !== 'current',
  ).length;

  const panel = (
    <div className="location-panel">
      {current && (
        <motion.div
          className="location-card active location-current-card"
          initial={{opacity: 0, x: -18}}
          animate={{opacity: 1, x: 0}}
        >
          {current.visual_asset_urls?.location_view ? (
            <MediaAsset
              className="location-card-art"
              src={current.visual_asset_urls.location_view}
              alt=""
              aria-hidden
            />
          ) : (
            <Compass size={18} />
          )}
          <span>
            <strong>{current.name}</strong>
            <small>current location</small>
          </span>
        </motion.div>
      )}
      <button
        type="button"
        className="location-map-button"
        disabled={busy}
        onClick={() => {
          setOpen(false);
          onOpenMap();
        }}
      >
        <Map size={17} />
        <span>Open city map</span>
        <small>{exitCount} exits</small>
      </button>
    </div>
  );

  if (collapsed) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="rail-icon" aria-label="locations">
            <Compass size={18} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" className="rail-popover">
          <div className="rail-popover-inner">
            <div className="section-title">Location</div>
            {panel}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <>
      <div className="section-title">Location</div>
      {panel}
    </>
  );
}
