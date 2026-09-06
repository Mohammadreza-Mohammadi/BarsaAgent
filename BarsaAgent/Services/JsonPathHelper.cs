using System;
using System.Collections.Generic;
using System.Text.Json;

namespace BarsaAgent.Services;

/// <summary>
/// ابزار عمومی برای کار با JsonElement بر اساس مسیرهای dot-notation (مثل "fields.title").
/// طراحی شده تا با هر شکلی از پاسخ REST (به‌جز آرایه‌های تودرتو در مسیر) کار کند،
/// چون فرمت وب‌سرویس از قبل مشخص نیست و کاربر خودش مپینگ را تعریف می‌کند.
/// </summary>
public static class JsonPathHelper
{
    /// <summary>
    /// آرایه‌ی ایشوها را از ریشه‌ی پاسخ پیدا می‌کند.
    /// اگر rootPath خالی باشد، انتظار می‌رود خودِ ریشه یک آرایه باشد.
    /// </summary>
    public static bool TryGetIssuesArray(JsonElement root, string rootPath, out JsonElement arrayElement)
    {
        if (string.IsNullOrWhiteSpace(rootPath))
        {
            if (root.ValueKind == JsonValueKind.Array)
            {
                arrayElement = root;
                return true;
            }

            arrayElement = default;
            return false;
        }

        if (!TryGetByPath(root, rootPath, out var found) || found.ValueKind != JsonValueKind.Array)
        {
            arrayElement = default;
            return false;
        }

        arrayElement = found;
        return true;
    }

    /// <summary>مقدار JsonElement را در یک مسیر dot-notation نسبت به یک المان والد پیدا می‌کند.</summary>
    public static bool TryGetByPath(JsonElement root, string path, out JsonElement result)
    {
        var current = root;

        if (string.IsNullOrWhiteSpace(path))
        {
            result = default;
            return false;
        }

        foreach (var segment in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out var next))
            {
                result = default;
                return false;
            }

            current = next;
        }

        result = current;
        return true;
    }

    /// <summary>مقدار یک مسیر را به‌صورت رشته برمی‌گرداند (برای اعداد/بولین هم ToString می‌شود).</summary>
    public static string GetString(JsonElement root, string path)
    {
        if (!TryGetByPath(root, path, out var value))
            return "";

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Null or JsonValueKind.Undefined => "",
            _ => value.ToString()
        };
    }

    /// <summary>مقدار یک مسیر را به‌صورت لیستی از رشته‌ها برمی‌گرداند (وقتی مسیر یک آرایه JSON است).</summary>
    public static List<string> GetStringArray(JsonElement root, string path)
    {
        var list = new List<string>();

        if (!TryGetByPath(root, path, out var value) || value.ValueKind != JsonValueKind.Array)
            return list;

        foreach (var item in value.EnumerateArray())
        {
            list.Add(item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : item.ToString());
        }

        return list;
    }

    /// <summary>
    /// فیلدهای یک آبجکت JSON را به‌صورت مسیرهای dot-notation "صاف" می‌کند تا در UI مپینگ نمایش داده شوند.
    /// فقط داخل آبجکت‌ها می‌رود؛ آرایه‌ها را به‌عنوان یک فیلد ساده (نه باز‌شده) گزارش می‌کند.
    /// </summary>
    public static List<string> FlattenPaths(JsonElement element, string prefix = "", int maxDepth = 4)
    {
        var result = new List<string>();

        if (maxDepth < 0 || element.ValueKind != JsonValueKind.Object)
            return result;

        foreach (var prop in element.EnumerateObject())
        {
            var path = string.IsNullOrEmpty(prefix) ? prop.Name : $"{prefix}.{prop.Name}";

            if (prop.Value.ValueKind == JsonValueKind.Object)
            {
                result.AddRange(FlattenPaths(prop.Value, path, maxDepth - 1));
            }
            else
            {
                result.Add(path);
            }
        }

        return result;
    }
}
