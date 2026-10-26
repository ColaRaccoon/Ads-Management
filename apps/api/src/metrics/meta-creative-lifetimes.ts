type Placement = {
  connectionId: string | null;
  metaCampaignId: string;
  creative: { creativeKey: string };
  firstSeenOn: Date | null;
  lastSeenOn: Date | null;
};

export const creativeLifetimeKey = (connectionId: string | null, creativeKey: string) =>
  JSON.stringify([connectionId, creativeKey]);

/** Observed lifetime, independent of the selected day's delivery filter.
 * Legacy CSV placements join an account only through an unambiguous Meta
 * campaign ID seen on that account, never just a shared creative name.
 */
export function aggregateCreativeLifetimes(placements: readonly Placement[], through: Date) {
  const owners = new Map<string, Set<string>>();
  for (const row of placements) {
    if (!row.connectionId) continue;
    const connections = owners.get(row.metaCampaignId) ?? new Set<string>();
    connections.add(row.connectionId);
    owners.set(row.metaCampaignId, connections);
  }
  const result = new Map<string, { firstSeenOn: Date; lastSeenOn: Date }>();
  const add = (row: Placement, connectionId: string | null) => {
    if (!row.firstSeenOn || !row.lastSeenOn || row.firstSeenOn > through) return;
    const lastSeenOn = row.lastSeenOn > through ? through : row.lastSeenOn;
    const key = creativeLifetimeKey(connectionId, row.creative.creativeKey);
    const previous = result.get(key);
    result.set(key, {
      firstSeenOn: previous && previous.firstSeenOn < row.firstSeenOn ? previous.firstSeenOn : row.firstSeenOn,
      lastSeenOn: previous && previous.lastSeenOn > lastSeenOn ? previous.lastSeenOn : lastSeenOn
    });
  };
  for (const row of placements) {
    add(row, row.connectionId);
    if (row.connectionId === null) {
      const connections = owners.get(row.metaCampaignId);
      if (connections?.size === 1) add(row, [...connections][0]);
    }
  }
  return result;
}
