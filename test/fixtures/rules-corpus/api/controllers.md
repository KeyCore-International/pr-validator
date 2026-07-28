# API controllers

- Controllers depend on the unit of work and the mapper, never on a repository directly.
- Every action returns the shared response envelope.
- Paginated endpoints accept `page` and `pageSize` and never return unbounded lists.
