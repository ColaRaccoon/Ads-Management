import { QueryClient } from "@tanstack/react-query";

export function clearUserQueries(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "auth"
  });
}
