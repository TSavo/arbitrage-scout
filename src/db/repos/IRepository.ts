/**
 * Base repository interface. Every repo implements at minimum these operations.
 */
export interface IRepository<T, ID = string> {
  findById(id: ID): Promise<T | null>;
  findAll(opts?: { limit?: number; offset?: number }): Promise<T[]>;
  create(data: Omit<T, "id">): Promise<T>;
  update(id: ID, data: Partial<T>): Promise<T | null>;
  delete(id: ID): Promise<boolean>;
  count(): Promise<number>;
}
