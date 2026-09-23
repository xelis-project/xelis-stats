import entitiesJson from "../../config/entities.json";

export interface KnownEntity {
  address: string;
  label: string;
  kind: string;
  link?: string;
}

interface EntitiesFile {
  entities: KnownEntity[];
}

const file = entitiesJson as EntitiesFile;

export const knownEntities: readonly KnownEntity[] = file.entities;

export const entitiesByAddress: ReadonlyMap<string, KnownEntity> = new Map(
  file.entities.map((e) => [e.address, e]),
);

export function knownEntity(address: string): KnownEntity | undefined {
  return entitiesByAddress.get(address);
}