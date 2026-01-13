/**
 * RustyRoad Plugin for OpenCode
 *
 * This plugin provides RustyRoad database tools directly to OpenCode agents,
 * preventing them from using raw psql commands or connecting to wrong databases.
 *
 * Tools provided:
 * - rustyroad_query: Execute SQL queries
 * - rustyroad_schema: Get database schema
 * - rustyroad_migrate: Run migrations
 * - rustyroad_config: View configuration
 */

import { type PluginInput, type Hooks } from "@opencode-ai/plugin"
import { spawn } from "child_process"

// Find the rustyroad binary
async function findRustyRoadBinary(): Promise<string> {
  // Check common locations
  const locations = [
    "/home/riley/RustyRoad/target/release/rustyroad",
    "/home/riley/RustyRoad/target/debug/rustyroad",
    "/usr/local/bin/rustyroad",
    "rustyroad", // PATH
  ]

  for (const loc of locations) {
    try {
      const proc = Bun.spawn(["which", loc], { stdout: "pipe" })
      await proc.exited
      if (proc.exitCode === 0) {
        return loc
      }
    } catch {
      // Try the path directly
      try {
        const file = Bun.file(loc)
        if (await file.exists()) {
          return loc
        }
      } catch {
        continue
      }
    }
  }

  throw new Error("rustyroad binary not found")
}

// Execute rustyroad command and return output
async function execRustyRoad(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binary = await findRustyRoadBinary()
  
  const proc = Bun.spawn([binary, ...args], {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  return {
    stdout,
    stderr,
    exitCode: proc.exitCode ?? 1,
  }
}

export default function rustyroad(input: PluginInput): Hooks {
  return {
    tool: {
      rustyroad_query: {
        description:
          "Execute a SQL query against the RustyRoad database. Returns results as text. Use this instead of psql or direct database connections. Always use this for database queries in RustyRoad projects.",
        parameters: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "The SQL query to execute",
            },
            env: {
              type: "string",
              description: "Environment to use (dev, prod, test). Defaults to dev.",
              enum: ["dev", "prod", "test"],
            },
            project_dir: {
              type: "string",
              description: "Path to the RustyRoad project directory. Defaults to current directory.",
            },
          },
          required: ["sql"],
        },
        async execute(args: { sql: string; env?: string; project_dir?: string }) {
          const env = args.env || "dev"
          const cwd = args.project_dir || input.directory || process.cwd()

          const result = await execRustyRoad(["query", args.sql], {
            cwd,
            env: { ENVIRONMENT: env },
          })

          if (result.exitCode !== 0) {
            return {
              success: false,
              error: result.stderr || "Query failed",
              environment: env,
            }
          }

          return {
            success: true,
            environment: env,
            output: result.stdout,
          }
        },
      },

      rustyroad_schema: {
        description:
          "Get the database schema (tables and columns) from a RustyRoad project. Use this to understand what tables exist before writing queries.",
        parameters: {
          type: "object",
          properties: {
            env: {
              type: "string",
              description: "Environment to use (dev, prod, test)",
              enum: ["dev", "prod", "test"],
            },
            project_dir: {
              type: "string",
              description: "Path to the RustyRoad project directory",
            },
          },
        },
        async execute(args: { env?: string; project_dir?: string }) {
          const env = args.env || "dev"
          const cwd = args.project_dir || input.directory || process.cwd()

          const result = await execRustyRoad(["db", "schema"], {
            cwd,
            env: { ENVIRONMENT: env },
          })

          if (result.exitCode !== 0) {
            return {
              success: false,
              error: result.stderr || "Failed to get schema",
              environment: env,
            }
          }

          return {
            success: true,
            environment: env,
            schema: result.stdout,
          }
        },
      },

      rustyroad_migrate: {
        description:
          "Run database migrations in a RustyRoad project. Use 'up' to apply pending migrations, 'down' to rollback.",
        parameters: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              description: "Migration direction: up (apply), down (rollback), or list (show status)",
              enum: ["up", "down", "list"],
            },
            name: {
              type: "string",
              description: "Optional: Run a specific migration by name",
            },
            env: {
              type: "string",
              description: "Environment to use (dev, prod, test)",
              enum: ["dev", "prod", "test"],
            },
            project_dir: {
              type: "string",
              description: "Path to the RustyRoad project directory",
            },
          },
          required: ["direction"],
        },
        async execute(args: {
          direction: string
          name?: string
          env?: string
          project_dir?: string
        }) {
          const env = args.env || "dev"
          const cwd = args.project_dir || input.directory || process.cwd()

          let command: string[]
          switch (args.direction) {
            case "up":
              command = args.name
                ? ["migration", "run", args.name]
                : ["migration", "all"]
              break
            case "down":
              if (!args.name) {
                return {
                  success: false,
                  error: "Migration name is required for rollback (down) direction",
                }
              }
              command = ["migration", "rollback", args.name]
              break
            case "list":
              command = ["migration", "list", "--format", "json"]
              break
            default:
              return {
                success: false,
                error: `Invalid direction: ${args.direction}`,
              }
          }

          const result = await execRustyRoad(command, {
            cwd,
            env: { ENVIRONMENT: env },
          })

          if (result.exitCode !== 0) {
            return {
              success: false,
              error: result.stderr || "Migration failed",
              environment: env,
            }
          }

          return {
            success: true,
            environment: env,
            output: result.stdout,
          }
        },
      },

      rustyroad_migration_generate: {
        description:
          "Generate a new migration file with up.sql and down.sql in a RustyRoad project.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Migration name (e.g., 'create_users', 'add_email_to_customers')",
            },
            columns: {
              type: "array",
              items: { type: "string" },
              description:
                "Column definitions in format name:type[:constraints] (e.g., 'email:string:not_null,unique')",
            },
            project_dir: {
              type: "string",
              description: "Path to the RustyRoad project directory",
            },
          },
          required: ["name"],
        },
        async execute(args: {
          name: string
          columns?: string[]
          project_dir?: string
        }) {
          const cwd = args.project_dir || input.directory || process.cwd()

          const command = ["migration", "generate", args.name]
          if (args.columns && args.columns.length > 0) {
            command.push(...args.columns)
          }

          const result = await execRustyRoad(command, { cwd })

          if (result.exitCode !== 0) {
            return {
              success: false,
              error: result.stderr || "Failed to generate migration",
            }
          }

          return {
            success: true,
            output: result.stdout,
            next_step:
              "Edit the migration files in ./config/database/migrations/ if needed, then use rustyroad_migrate with direction 'up'",
          }
        },
      },

      rustyroad_config: {
        description:
          "Get current RustyRoad configuration including database connection info. Use this to verify which database you're connected to.",
        parameters: {
          type: "object",
          properties: {
            env: {
              type: "string",
              description: "Environment to show config for",
              enum: ["dev", "prod", "test"],
            },
            project_dir: {
              type: "string",
              description: "Path to the RustyRoad project directory",
            },
          },
        },
        async execute(args: { env?: string; project_dir?: string }) {
          const env = args.env || "dev"
          const cwd = args.project_dir || input.directory || process.cwd()

          const result = await execRustyRoad(["config", "--format", "json"], {
            cwd,
            env: { ENVIRONMENT: env },
          })

          if (result.exitCode !== 0) {
            return {
              success: false,
              error: result.stderr || "Failed to get config",
            }
          }

          try {
            const config = JSON.parse(result.stdout)
            return {
              success: true,
              ...config,
            }
          } catch {
            return {
              success: true,
              output: result.stdout,
            }
          }
        },
      },

      rustyroad_convert_migrations: {
        description:
          "Detect and convert rogue SQL migrations (files in ./migrations/ instead of ./config/database/migrations/) to RustyRoad format. Use this when you've accidentally created migrations in the wrong location.",
        parameters: {
          type: "object",
          properties: {
            dry_run: {
              type: "boolean",
              description:
                "If true, only show what would be converted without making changes",
            },
            remove_source: {
              type: "boolean",
              description: "If true, remove original files after conversion",
            },
            project_dir: {
              type: "string",
              description: "Path to the RustyRoad project directory",
            },
          },
        },
        async execute(args: {
          dry_run?: boolean
          remove_source?: boolean
          project_dir?: string
        }) {
          const cwd = args.project_dir || input.directory || process.cwd()

          const command = ["migration", "convert"]
          if (args.dry_run) {
            command.push("--dry-run")
          }
          if (args.remove_source) {
            command.push("--remove-source")
          }

          const result = await execRustyRoad(command, { cwd })

          if (result.exitCode !== 0) {
            return {
              success: false,
              error: result.stderr || "Conversion failed",
            }
          }

          return {
            success: true,
            output: result.stdout,
          }
        },
      },
    },
  }
}
