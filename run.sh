#!/bin/bash
# Starts the server, runs the real end-to-end API test suite against it, then stops it.
cd "$(dirname "$0")/.."
rm -f data/loadmasr.db*
node src/server.js > /tmp/loadmasr-server.log 2>&1 &
SERVER_PID=$!
sleep 1.5
node test/api.test.js
TEST_EXIT=$?
kill $SERVER_PID 2>/dev/null
exit $TEST_EXIT
