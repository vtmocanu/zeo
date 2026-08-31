/**
 * A named workspace in the Zeo domain model. Each space owns its own tab set
 * (an independent {@link TabStore}) and references a profile.
 *
 * This is a plain data record with no behavior; the space lifecycle (create,
 * rename, delete, active-space switching) and the per-space tab sets live in
 * {@link SpaceStore}.
 */
export interface Space {
  id: string;
  name: string;
  /**
   * Reference to the owning profile. A plain string for now — the profile
   * entity lands in PRD 3.2; every space created without an explicit profile
   * references `"default"`.
   */
  profileId: string;
  createdAt: number;
}
