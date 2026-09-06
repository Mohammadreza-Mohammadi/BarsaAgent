using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using BarsaAgent.Models;

namespace BarsaAgent.Services;

/// <summary>
/// مسئول فراخوانی وب‌سرویس REST (GET + Header API Key) و تبدیل پاسخ خام JSON
/// به لیستی از AgentIssue بر اساس FieldMapping تعریف‌شده توسط کاربر.
/// </summary>
public class IssueService
{
    private readonly HttpClient _http;

    public IssueService(HttpClient http)
    {
        _http = http;
    }

    /// <summary>پاسخ خام وب‌سرویس را می‌گیرد و به‌صورت JsonDocument برمی‌گرداند (برای Fetch اصلی و Sample هر دو استفاده می‌شود).</summary>
    public async Task<JsonDocument> FetchRawAsync(string url, string apiKeyHeaderName, string apiKeyValue)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new ArgumentException("آدرس وب‌سرویس خالی است.");

        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        if (!string.IsNullOrWhiteSpace(apiKeyHeaderName) && !string.IsNullOrWhiteSpace(apiKeyValue))
        {
            request.Headers.TryAddWithoutValidation(apiKeyHeaderName, apiKeyValue);
        }

        using var response = await _http.SendAsync(request);
        var body = await response.Content.ReadAsStringAsync();

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"وب‌سرویس با کد {(int)response.StatusCode} پاسخ داد. متن پاسخ:\n{Truncate(body, 500)}");
        }

        return JsonDocument.Parse(body);
    }

    /// <summary>اولین آیتم آرایه‌ی ایشوها را برای پیش‌نمایش/تشخیص فیلدها برمی‌گرداند (استفاده در فرم Mapping).</summary>
    public JsonElement? GetSampleItem(JsonDocument doc, string rootPath)
    {
        if (!JsonPathHelper.TryGetIssuesArray(doc.RootElement, rootPath, out var array))
            return null;

        foreach (var item in array.EnumerateArray())
            return item;

        return null;
    }

    /// <summary>تمام آیتم‌های آرایه ایشوها را با اعمال FieldMapping به AgentIssue تبدیل می‌کند.</summary>
    public List<AgentIssue> MapIssues(JsonDocument doc, AppConfig config)
    {
        var result = new List<AgentIssue>();
        var mapping = config.Mapping;

        if (!JsonPathHelper.TryGetIssuesArray(doc.RootElement, config.RootPath, out var array))
        {
            throw new InvalidOperationException(
                "آرایه‌ی ایشوها در پاسخ وب‌سرویس پیدا نشد. مسیر Root Path را در تنظیمات Mapping بررسی کنید.");
        }

        foreach (var item in array.EnumerateArray())
        {
            var issue = new AgentIssue
            {
                Id = JsonPathHelper.GetString(item, mapping.IdPath),
                Title = JsonPathHelper.GetString(item, mapping.TitlePath),
                Description = JsonPathHelper.GetString(item, mapping.DescriptionPath),
                AcceptanceCriteria = ExtractAcceptanceCriteria(item, mapping)
            };

            if (!string.IsNullOrWhiteSpace(mapping.SlugPath))
            {
                var slug = JsonPathHelper.GetString(item, mapping.SlugPath);
                issue.Slug = string.IsNullOrWhiteSpace(slug) ? null : slug;
            }

            if (!string.IsNullOrWhiteSpace(issue.Id))
                result.Add(issue);
        }

        return result;
    }

    private static List<string> ExtractAcceptanceCriteria(JsonElement item, FieldMapping mapping)
    {
        if (mapping.AcceptanceCriteriaMode == AcceptanceCriteriaMode.ArrayField)
        {
            return JsonPathHelper.GetStringArray(item, mapping.AcceptanceCriteriaPath);
        }

        var text = JsonPathHelper.GetString(item, mapping.AcceptanceCriteriaPath);
        if (string.IsNullOrWhiteSpace(text))
            return new List<string>();

        var delimiter = string.IsNullOrEmpty(mapping.AcceptanceCriteriaDelimiter)
            ? "\n"
            : mapping.AcceptanceCriteriaDelimiter;

        string[] parts = delimiter == "\n"
            ? text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries)
            : text.Split(new[] { delimiter }, StringSplitOptions.RemoveEmptyEntries);

        return parts.Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
    }

    private static string Truncate(string text, int max)
    {
        return text.Length <= max ? text : text[..max] + "...";
    }
}
