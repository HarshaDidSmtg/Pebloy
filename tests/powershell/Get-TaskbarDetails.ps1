param([Parameter(Mandatory)][long]$WindowHandle)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PebloyTaskbarDetails {
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey {
        public Guid Format;
        public uint Id;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropertyVariant {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Value;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropertyVariant value);
        void SetValue(ref PropertyKey key, ref PropertyVariant value);
        void Commit();
    }

    [DllImport("shell32.dll", PreserveSig = false)]
    private static extern void SHGetPropertyStoreForWindow(IntPtr window, ref Guid id, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropertyVariant value);

    public static string Read(long window, uint propertyId) {
        Guid interfaceId = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        SHGetPropertyStoreForWindow(new IntPtr(window), ref interfaceId, out store);
        try {
            PropertyKey key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = propertyId };
            PropertyVariant value;
            store.GetValue(ref key, out value);
            try {
                if (value.Type == 0) return null;
                if (value.Type != 31) throw new InvalidOperationException("Unexpected taskbar property type: " + value.Type);
                return Marshal.PtrToStringUni(value.Value);
            } finally { PropVariantClear(ref value); }
        } finally { Marshal.ReleaseComObject(store); }
    }
}
'@

[pscustomobject]@{
    appId = [PebloyTaskbarDetails]::Read($WindowHandle, 5)
    iconResource = [PebloyTaskbarDetails]::Read($WindowHandle, 3)
    relaunchCommand = [PebloyTaskbarDetails]::Read($WindowHandle, 2)
    displayName = [PebloyTaskbarDetails]::Read($WindowHandle, 4)
} | ConvertTo-Json -Compress