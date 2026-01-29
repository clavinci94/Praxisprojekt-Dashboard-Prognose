import pandas as pd

base_path = "/Users/claudio/Desktop/Projekt Cargologic"

df_tra_import = pd.read_csv(f"{base_path}/cl_tra_import.csv")
df_tra_export = pd.read_csv(f"{base_path}/cl_tra_export.csv")
df_import = pd.read_csv(f"{base_path}/cl_import.csv")
df_export = pd.read_csv(f"{base_path}/cl_export.csv")

print("TRA Import:", df_tra_import.shape)
print("TRA Export:", df_tra_export.shape)
print("Import:", df_import.shape)
print("Export:", df_export.shape)

print("IMPORT columns:")
print(df_import.columns.tolist())

print("\nEXPORT columns:")
print(df_export.columns.tolist())

print("\nTRA IMPORT columns:")
print(df_tra_import.columns.tolist())

print("\nTRA EXPORT columns:")
print(df_tra_export.columns.tolist())
