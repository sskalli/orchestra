import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PathReservation = { id: string; pid: number; directories: string[] };

export function acquirePathReservations({ id, directories }: Pick<PathReservation, "id" | "directories">) {
  const acquired: string[] = [];
  try {
    for (const directory of directories) {
      const temporary = mkdtempSync(join(dirname(directory), "orchestra-checkout-write-"));
      try {
        writeFileSync(join(temporary, id), "");
        // A populated destination cannot be replaced by another rename.
        renameSync(temporary, directory);
        acquired.push(directory);
      } catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          throw new Error("Another Orchestra task has reserved an approved checkout. Wait for it to finish or recover its workspace.");
        }
        throw error;
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  } catch (error) {
    releasePathReservations({ id, directories: acquired });
    throw error;
  }
}

export function releasePathReservations({ id, directories }: Pick<PathReservation, "id" | "directories">) {
  let released = true;
  for (const directory of directories) {
    try {
      // Only the process that removes this run's marker can remove its directory.
      unlinkSync(join(directory, id));
      rmdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") released = false;
    }
  }
  return released;
}

export function reservationOwnerAlive({ pid }: Pick<PathReservation, "pid">) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
