# A genuinely clean machine.
#
#     docker build -t libertynet-p6 p6/
#     docker run --rm -it libertynet-p6
#
# The point of P6 is finding out what a stranger experiences. That is impossible
# on a machine that already has the repository cloned, the venv built, gcloud
# authenticated and the answers in shell history — every one of those quietly
# removes a step the stranger would have hit.
#
# So: a bare image with a shell, curl, Node and Python, and nothing else. No
# LibertyNet code, no credentials, no cached anything. If the quickstart works
# here it works for a stranger, and if it does not, the gap is real.

# Start from the official Node image rather than installing Node onto Debian.
# The nodesource route worked but took several minutes, and a kit somebody else
# has to run should not have a five-minute step that can fail on a slow network.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-pip python3-venv git jq \
  && rm -rf /var/lib/apt/lists/*

# A non-root user, because a tester who is root will not hit the permission
# problems a real developer hits.
RUN useradd -ms /bin/bash tester
USER tester
WORKDIR /home/tester

# The timing harness is the ONLY thing copied in. Everything else the tester must
# obtain the way anyone else would — from the public documentation.
COPY --chown=tester:tester timer.mjs /home/tester/timer.mjs

ENV LN_P6=1

RUN printf '%s\n' \
  '' \
  '  LibertyNet P6 — clean machine' \
  '' \
  '  Nothing LibertyNet is installed. That is deliberate.' \
  '' \
  '  Start at https://docs.libertynet.ai/quickstart and follow it exactly.' \
  '  Do not look at the repository. If the docs do not tell you something,' \
  '  that IS the finding — write it down rather than working it out.' \
  '' \
  '  Time each step:   node timer.mjs start "step 1"' \
  '                    node timer.mjs done  "step 1"' \
  '                    node timer.mjs stuck "no idea what a DID is"' \
  '                    node timer.mjs report' \
  '' \
  > /home/tester/WELCOME.txt

CMD ["/bin/bash", "-c", "cat /home/tester/WELCOME.txt && exec bash"]
