# Operator builds this reviewed source explicitly; never build workspace code automatically.
ARG BASE=alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
FROM ${BASE}
RUN sed -i 's|http://|https://|g' /etc/apk/repositories && apk add --no-cache bash python3 curl ca-certificates util-linux
COPY files.py entry.py /opt/pi-chat/
RUN chmod 0555 /opt/pi-chat/*.py && mkdir /workspace /shared
LABEL org.pi-chat.helper="1"
ENTRYPOINT ["/usr/bin/python3", "-I", "/opt/pi-chat/entry.py"]
CMD []
