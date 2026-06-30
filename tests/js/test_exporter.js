// CSV export shaping (pure; no DOM needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tablesToCsv } from "../../assets/js/exporter.js";

test("CSV: header, padding, and quoting", () => {
  const tables = [
    {
      page: 1,
      source: "text-layout",
      columns: ["Date", "Description", "Amount"],
      rows: [
        ["01/04/2024", "Opening, Balance", "12500.00"],
        ["05/04/2024", 'SALARY "ACME"'], // short row -> padded
      ],
      columnSeparators: [],
    },
  ];
  const csv = tablesToCsv(tables);
  const lines = csv.replace(/^﻿/, "").split("\r\n");
  assert.equal(lines[0], "Date,Description,Amount");
  // Comma inside a field is quoted.
  assert.equal(lines[1], '01/04/2024,"Opening, Balance",12500.00');
  // Embedded quotes are doubled and the short row is padded to 3 columns.
  assert.equal(lines[2], '05/04/2024,"SALARY ""ACME""",');
});
