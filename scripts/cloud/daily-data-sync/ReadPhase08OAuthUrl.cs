// Private filesystem/DPAPI reader for a trusted browser caller; no UI or network.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class ReadPhase08OAuthUrl {
  const string Root = @"C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime";
  static void PrivatePath(string path, bool directory) {
    FileSystemInfo item = directory ? (FileSystemInfo)new DirectoryInfo(path) : new FileInfo(path);
    if (!item.Exists || (item.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception();
    FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
    if (!acl.AreAccessRulesProtected) throw new Exception();
    string user = WindowsIdentity.GetCurrent().User.Value;
    string owner = acl.GetOwner(typeof(SecurityIdentifier)).Value;
    if (owner != user && owner != "S-1-5-18") throw new Exception();
    var found = new HashSet<string>();
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      string sid = rule.IdentityReference.Value;
      if ((sid != user && sid != "S-1-5-18") || rule.AccessControlType != AccessControlType.Allow ||
          rule.FileSystemRights != FileSystemRights.FullControl) throw new Exception();
      found.Add(sid);
    }
    if (!found.Contains(user) || !found.Contains("S-1-5-18")) throw new Exception();
  }
  static string Text(Dictionary<string, object> record, string key) {
    object value;
    if (!record.TryGetValue(key, out value) || !(value is string) || ((string)value).Length > 8192) throw new Exception();
    return (string)value;
  }
  public static string ValidateRecord(Dictionary<string, object> record, DateTimeOffset now) {
    object version;
    if (record == null || record.Count != 9 || !record.TryGetValue("version", out version) ||
        !(version is int) || (int)version != 1 || Text(record,"projectRef") != "ehnfrrmbkvlsbpvqcvkr" ||
        Text(record,"schema") != "phase08_meta_ads" || Text(record,"serviceId") != "4b30daa8-9333-46b7-ad89-cfd64ff5266c" ||
        Text(record,"connectionId") != "0c35defe-45fc-4a54-bc79-704df7bca5b1" ||
        Text(record,"origin") != "https://phase08-daily-data-sync-production.up.railway.app") throw new Exception();
    DateTimeOffset created, expires;
    if (!DateTimeOffset.TryParseExact(Text(record,"createdAt"),"O",CultureInfo.InvariantCulture,DateTimeStyles.None,out created) ||
        !DateTimeOffset.TryParseExact(Text(record,"expiresAt"),"O",CultureInfo.InvariantCulture,DateTimeStyles.None,out expires) ||
        created > now.AddSeconds(5) || expires != created.AddSeconds(300) || expires <= now) throw new Exception();
    string url = Text(record,"authorizeUrl");
    if (!url.StartsWith("https://didadi0729.cafe24api.com/api/v2/oauth/authorize?",StringComparison.Ordinal)) throw new Exception();
    var uri = new Uri(url);
    if (uri.Scheme != "https" || uri.Authority != "didadi0729.cafe24api.com" ||
        uri.AbsolutePath != "/api/v2/oauth/authorize" || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0) throw new Exception();
    var values = new Dictionary<string,string>(StringComparer.Ordinal);
    string[] pieces = uri.Query.Substring(1).Split('&');
    if (pieces.Length != 5) throw new Exception();
    foreach (string piece in pieces) {
      string[] pair = piece.Split(new char[]{'='},2);
      if (pair.Length != 2 || values.ContainsKey(pair[0]) ||
          (pair[0] != "response_type" && pair[0] != "client_id" && pair[0] != "redirect_uri" && pair[0] != "scope" && pair[0] != "state")) throw new Exception();
      values.Add(pair[0],Uri.UnescapeDataString(pair[1]));
    }
    if (values["response_type"] != "code" || values["client_id"] != "tVV6DZtPOFRlpPk1ex7ISA" ||
        values["scope"] != "mall.read_order" || values["redirect_uri"] != "https://phase08-daily-data-sync-production.up.railway.app/backend-api/integrations/cafe24/oauth/callback" ||
        !Regex.IsMatch(values["state"],@"\A[A-Za-z0-9_-]{43}\z")) throw new Exception();
    return url;
  }
  public static string ReadProtected() {
    string path = Path.Combine(Root,"cafe24-oauth-attempt.dpapi");
    if (Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) != @"C:\Users\seong\AppData\Local") throw new Exception();
    var local = new DirectoryInfo(@"C:\Users\seong\AppData\Local");
    if ((local.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception();
    PrivatePath(Root,true); PrivatePath(path,false);
    long size = new FileInfo(path).Length;
    if (size < 32 || size > 16384) throw new Exception();
    byte[] all=null, encrypted=null, plain=null;
    try {
      all=File.ReadAllBytes(path);
      if (all.Length != size) throw new Exception();
      byte[] magic=Encoding.ASCII.GetBytes("PHASE08-CAFE-OAUTH-1");
      for (int i=0;i<magic.Length;i++) if (all[i] != magic[i]) throw new Exception();
      encrypted=new byte[all.Length-magic.Length]; Array.Copy(all,magic.Length,encrypted,0,encrypted.Length);
      plain=ProtectedData.Unprotect(encrypted,Encoding.ASCII.GetBytes("MetaAdsPhase08/CafeOAuth/v1"),DataProtectionScope.CurrentUser);
      if (plain.Length > 16384) throw new Exception();
      var serializer=new JavaScriptSerializer(); serializer.MaxJsonLength=16384; serializer.RecursionLimit=10;
      var record=serializer.Deserialize<Dictionary<string,object>>(new UTF8Encoding(false,true).GetString(plain));
      return ValidateRecord(record,DateTimeOffset.UtcNow);
    } finally {
      foreach (byte[] data in new byte[][]{all,encrypted,plain}) if (data != null) Array.Clear(data,0,data.Length);
    }
  }
  public static int Main(string[] arguments) {
    try {
      if (arguments.Length != 0) throw new Exception();
      Console.OutputEncoding=new UTF8Encoding(false,true);
      Console.Write(ReadProtected()); return 0;
    } catch { Console.Error.Write("PHASE08_PROTECTED_OAUTH_URL_UNAVAILABLE"); return 1; }
  }
}
