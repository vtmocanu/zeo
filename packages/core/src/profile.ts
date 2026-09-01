/**
 * A profile in the Zeo domain model. Each profile backs an Electron session
 * partition (`persist:<id>`), giving the spaces that reference it real
 * cookie/storage isolation; multiple spaces may share one profile.
 *
 * This is a plain data record with no behavior; the profile lifecycle (create,
 * rename, delete, read access) and the space→profile references live in
 * {@link SpaceStore}.
 */
export interface Profile {
  id: string;
  name: string;
  createdAt: number;
}
