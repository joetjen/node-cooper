# Conformance oracle: runs every `*.casc` file in a directory through the
# Elixir reference implementation (`cooper`) and writes the canonical JSON
# rendering of its result next to it as `<name>.expected.json`.
#
# Run from a checkout of https://github.com/joetjen/cooper:
#
#     cd ../cooper && mix run ../node-cooper/scripts/oracle.exs ../node-cooper/test/conformance/cases
#
# The JS side (`test/conformance/oracle.spec.js`) loads the same files with
# the same options and compares its own canonical rendering against these
# files. The options below MUST stay identical to `test/conformance/options.js`,
# except `modules`: Node needs a mapping for every `!module` name, which
# Elixir translates by convention (see `test/conformance/DIVERGENCES.md`).

defmodule Oracle do
  @env %{
    "REGION" => "eu-west",
    "PORT" => "9090",
    "DEBUG" => "true",
    "EMPTY" => "",
    "LIST" => "a, b;c",
    "SCHEME" => "HTTPS://",
    "PADDED" => "  padded  ",
    "TOKEN_1" => "tok-one",
    "TOKEN_2" => "tok-two",
    "FEATURE" => "on",
    "WHICH" => "dev",
    "FORMATTER" => "Foo.Bar",
    "COOPER_ENV" => "conformance"
  }

  @mem %{
    "base" => "#@version = 1\nfrom_mem = true\nshared = \"mem\"\n",
    "vars" => "#@version = 1\n@mem_var = \"from-mem\"\n"
  }

  def opts(dir) do
    [
      env: @env,
      dotenv: false,
      root: dir,
      resolvers: %{
        "echo" => fn payload -> {:ok, payload} end,
        "fail" => fn payload -> {:error, "refused #{payload}"} end
      },
      tags: %{"twice" => fn
        n when is_integer(n) -> {:ok, n * 2}
        s when is_binary(s) -> {:ok, s <> s}
        other -> {:error, "cannot double #{inspect(other)}"}
      end},
      import_schemes: %{
        "mem" => fn rest ->
          case Map.fetch(@mem, rest) do
            {:ok, src} -> {:ok, src}
            :error -> {:error, :enoent}
          end
        end
      }
    ]
  end

  def canon(nil), do: nil
  def canon(b) when is_boolean(b), do: b
  def canon(:infinity), do: %{"float" => "inf"}
  def canon(:neg_infinity), do: %{"float" => "-inf"}
  # A module `!module` built by convention: the name as CASC wrote it, so
  # every implementation compares the name rather than its own host value.
  # A CASC atom can never hold a `.`, so nothing else starts `Elixir.`.
  def canon(a) when is_atom(a) do
    case Atom.to_string(a) do
      "Elixir." <> written -> %{"module" => written}
      name -> %{"atom" => name}
    end
  end
  def canon(i) when is_integer(i), do: %{"int" => Integer.to_string(i)}
  def canon(f) when is_float(f), do: %{"float" => f}
  def canon(s) when is_binary(s), do: s
  def canon(l) when is_list(l), do: Enum.map(l, &canon/1)
  def canon({:duration, ns}), do: %{"duration" => Integer.to_string(ns)}
  def canon({:bytes, n}), do: %{"bytes" => Integer.to_string(n)}
  def canon(%Cooper.Secret{value: v, redacted: r}), do: %{"secret" => canon(v), "redacted" => r}
  def canon(%Cooper.IPv4{} = ip), do: %{"ipv4" => to_string(ip)}
  def canon(%Cooper.IPv6{} = ip), do: %{"ipv6" => to_string(ip)}
  def canon(%Date{} = d), do: %{"date" => Date.to_iso8601(d)}
  def canon(%Time{} = t), do: %{"time" => Time.to_iso8601(t)}
  def canon(%NaiveDateTime{} = t), do: %{"localDateTime" => NaiveDateTime.to_iso8601(t)}
  def canon(%DateTime{} = t), do: %{"dateTime" => DateTime.to_iso8601(t)}
  def canon(t) when is_tuple(t), do: %{"tuple" => t |> Tuple.to_list() |> Enum.map(&canon/1)}
  def canon(%{} = m), do: %{"map" => m |> Enum.sort() |> Enum.map(fn {k, v} -> [key(k), canon(v)] end)}

  # A key that isn't a string is a reference-implementation bug (e.g. an
  # interpolated key left unresolved); render it visibly rather than crash.
  defp key(k) when is_binary(k), do: k
  defp key(k), do: "#UNRESOLVED<" <> inspect(k) <> ">"

  def error(%{stage: stage, message: message}), do: %{"error" => to_string(stage), "message" => message}
  def error([first | _]), do: error(first)
  def error(other), do: %{"error" => "unknown", "message" => inspect(other)}

  def run(dir) do
    dir = Path.expand(dir)

    for file <- dir |> Path.join("*.casc") |> Path.wildcard() |> Enum.sort() do
      source = File.read!(file)

      result =
        try do
          case Cooper.load_string(source, Keyword.put(opts(dir), :file, file)) do
            {:ok, value} -> %{"ok" => canon(value)}
            {:error, err} -> error(err)
          end
        rescue
          e -> %{"error" => "crash", "message" => Exception.message(e)}
        end

      out = Path.rootname(file) <> ".expected.json"
      File.write!(out, JSON.encode!(result) <> "\n")
      IO.puts("#{Path.basename(file)} -> #{inspect(Map.keys(result))}")
    end
  end
end

[dir] = System.argv()
Oracle.run(dir)
