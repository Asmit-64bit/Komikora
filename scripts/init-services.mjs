import { Client } from "pg";
import { S3Client, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

const required = ["DATABASE_URL", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}; run npm run env:setup first.`);
}

// This command initializes local development services only.
for (const name of ["DATABASE_URL", "S3_ENDPOINT"]) {
  const hostname = new URL(process.env[name]).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    throw new Error(`${name} must point to localhost for services:init.`);
  }
}

const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  await database.connect();
  await database.query("SELECT 1");
  console.log("PostgreSQL connection verified.");
} finally {
  await database.end();
}

const storage = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
try {
  try {
    await storage.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    console.log("Local S3 bucket exists; access policy left unchanged.");
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await storage.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
    console.log("Created local S3 bucket with default private access.");
  }
} finally {
  storage.destroy();
}
