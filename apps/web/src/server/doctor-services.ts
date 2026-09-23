import "server-only";
import { createDoctorPool, createDoctorRepository } from "@clarity/database/doctor-repository";

let repository: ReturnType<typeof createDoctorRepository> | undefined;

export function getDoctorRepository() {
  if (repository) return repository;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  repository = createDoctorRepository(createDoctorPool(connectionString));
  return repository;
}
