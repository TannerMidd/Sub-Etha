import assert from "node:assert/strict";
import test from "node:test";
import { resolveDatabaseDriver } from "../db";

function withoutDriverOverride(run: () => void): void {
    const previous = process.env.DATABASE_DRIVER;

    delete process.env.DATABASE_DRIVER;

    try {
        run();
    } finally {
        if (previous === undefined) {
            delete process.env.DATABASE_DRIVER;
        } else {
            process.env.DATABASE_DRIVER = previous;
        }
    }
}

test("neon hosts select the Neon HTTP driver automatically", () => {
    withoutDriverOverride(() => {
        assert.equal(
            resolveDatabaseDriver("postgres://user:pass@ep-name-123.eu-central-1.aws.neon.tech/db"),
            "neon",
        );
    });
});

test("local and self-hosted databases select the wire-protocol driver", () => {
    withoutDriverOverride(() => {
        assert.equal(
            resolveDatabaseDriver("postgres://sub_etha:sub_etha@db:5432/sub_etha"),
            "postgres",
        );
        assert.equal(
            resolveDatabaseDriver("postgresql://sub_etha:sub_etha@localhost:5432/sub_etha"),
            "postgres",
        );
        assert.equal(
            resolveDatabaseDriver("postgres://sub_etha:sub_etha@192.168.1.20:5432/sub_etha"),
            "postgres",
        );
    });
});

test("an explicit DATABASE_DRIVER beats host detection", () => {
    process.env.DATABASE_DRIVER = "postgres";

    try {
        assert.equal(
            resolveDatabaseDriver("postgres://user:pass@ep-name-123.aws.neon.tech/db"),
            "postgres",
        );
    } finally {
        delete process.env.DATABASE_DRIVER;
    }

    process.env.DATABASE_DRIVER = " NEON ";

    try {
        assert.equal(
            resolveDatabaseDriver("postgres://sub_etha:sub_etha@db:5432/sub_etha"),
            "neon",
        );
    } finally {
        delete process.env.DATABASE_DRIVER;
    }
});

test("unparseable connection strings are rejected", () => {
    withoutDriverOverride(() => {
        assert.throws(() => resolveDatabaseDriver("not-a-connection-string"), TypeError);
    });
});
