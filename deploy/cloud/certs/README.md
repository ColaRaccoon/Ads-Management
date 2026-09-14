# Supabase public trust root

`supabase-prod-ca-2021.crt` is the public CA supplied by the production project's
Supabase Database settings. It contains no private key or credentials.

Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

SHA-256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`

The runtime installs this CA in the operating system trust store so Prisma's
required TLS connection can verify the Supabase certificate and hostname.
Do not replace certificate verification with `accept_invalid_certs`.
